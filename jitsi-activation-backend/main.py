"""vMTB meeting infrastructure activation service.

Brings up (and tears down) every billable component a meeting needs:

  - ``jitsi-vm``            Compute Engine VM running JVB/Prosody/Jicofo
  - ``stt-service``         Cloud Run GPU service, scale-to-zero
  - ``opus-transcriber-proxy``  Cloud Run service, scale-to-zero

Cost model (important): this service NEVER writes Cloud Run scaling
configuration. A previous design patched ``min_instance_count`` 0->1 before a
meeting and back to 0 afterwards; when the "back to 0" step was forgotten, an
idle L4 GPU stayed resident for days (~Rs 56/hour). Instead, scale-from-zero
is driven purely by requests: each poll below issues an authenticated health
probe, and that request itself starts the GPU instance if it is cold.
Subsequent polls observe readiness, and Cloud Run reaps the instance by itself
once the meeting's WebSocket closes and traffic stops.

``POST /start-jitsi`` is polled by jitsi-frontend every few seconds until it
returns ``{"status": "already_running"}``, which means ALL components are up.
The endpoint is idempotent: each poll re-checks state and never blocks for
long.

Credentials come from Application Default Credentials (the service account
attached to this Cloud Run service). For local development you can instead set
``GCP_SERVICE_ACCOUNT_JSON`` to a full service-account JSON blob. The runtime
service account needs only:
  - Compute Engine instance start/stop/get on jitsi-vm
  - roles/run.invoker on stt-service and opus-transcriber-proxy (probes)
  - roles/run.viewer (to read the services' URLs)
"""

import json
import logging
import os
from typing import Any

import google.auth
import httpx
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.cloud import compute_v1
from google.oauth2 import id_token as google_id_token
from google.oauth2 import service_account

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("activation")

app = FastAPI(title="vMTB activation backend")

_DEFAULT_CORS_ORIGINS = ",".join(
    [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://vmtb-v2.3billionpairs.com",
        "https://server-vmtb-v2.3billionpairs.com",
        "https://meeting-vmtb-v2.3billionpairs.com",
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get("CORS_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",")
        if o.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Config:
    """Environment-driven configuration; no secrets hardcoded."""

    def __init__(self) -> None:
        self.project_id = os.environ.get("GCP_PROJECT_ID", "")
        self.zone = os.environ.get("GCP_ZONE", "asia-south1-c")
        self.instance_name = os.environ.get("JITSI_INSTANCE_NAME", "jitsi-vm")
        # Region where the Cloud Run services live (STT needs a GPU region;
        # asia-south1 L4 is invite-only, so the default is Singapore).
        self.region = os.environ.get("GCP_REGION", "asia-southeast1")
        self.stt_service_name = os.environ.get("STT_SERVICE_NAME", "stt-service")
        self.proxy_service_name = os.environ.get(
            "PROXY_SERVICE_NAME", "opus-transcriber-proxy"
        )
        # Per-request timeout for health probes. A cold GPU STT blocks its
        # first request while the container boots and the model loads; later
        # polls succeed quickly once /ready answers.
        self.stt_probe_timeout_seconds = float(
            os.environ.get("STT_PROBE_TIMEOUT_SECONDS", "15")
        )
        self.proxy_probe_timeout_seconds = float(
            os.environ.get("PROXY_PROBE_TIMEOUT_SECONDS", "8")
        )
        # Public Jitsi origin on the VM. GCP reports RUNNING before nginx and
        # Prosody finish booting; probing this URL (default: the real meet
        # host) keeps /start-jitsi in "starting" until the browser can
        # actually load external_api.js and open /xmpp-websocket.
        self.jitsi_public_url = os.environ.get(
            "JITSI_PUBLIC_URL", "https://server-vmtb-v2.3billionpairs.com"
        )
        self.jitsi_probe_timeout_seconds = float(
            os.environ.get("JITSI_PROBE_TIMEOUT_SECONDS", "5")
        )


cfg = Config()

# ---------------------------------------------------------------------------
# Lazy GCP clients (initialised on first use so /health works without creds)
# ---------------------------------------------------------------------------

_compute_client: compute_v1.InstancesClient | None = None


def _credentials():
    raw = os.environ.get("GCP_SERVICE_ACCOUNT_JSON")
    if raw:
        return service_account.Credentials.from_service_account_info(
            json.loads(raw)
        )
    credentials, _ = google.auth.default()
    return credentials


def compute_client() -> compute_v1.InstancesClient:
    global _compute_client
    if _compute_client is None:
        _compute_client = compute_v1.InstancesClient(credentials=_credentials())
    return _compute_client


def _service_url(service_name: str) -> str:
    """Read a Cloud Run service URL via the Admin API (read-only)."""
    from google.cloud import run_v2  # local import: only needed for reads

    client = run_v2.ServicesClient(credentials=_credentials())
    name = f"projects/{cfg.project_id}/locations/{cfg.region}/services/{service_name}"
    return client.get_service(name=name).uri or ""


def probe(base_url: str, path: str, timeout_seconds: float, require_status_ok: bool = False) -> bool:
    """GET a health endpoint, authenticating with an ID token when possible.

    The probe doubles as the scale-from-zero trigger: Cloud Run starts an
    instance to serve it. A cold STT instance may not answer within the first
    few attempts (model load); callers simply poll again.

    When ``require_status_ok`` is set, a 200 body must also carry
    ``{"status": "ok"}`` — /ready answers 200 with ``{"status": "loading"}``
    while the model is still coming up, which must not count as ready.
    """
    url = base_url.rstrip("/") + path
    headers: dict[str, str] = {}
    try:
        token = google_id_token.fetch_id_token(GoogleAuthRequest(), base_url)
        if token:
            headers["Authorization"] = f"Bearer {token}"
    except Exception as exc:  # noqa: BLE001 - fall back to unauthenticated
        log.debug("id token fetch failed for %s (%s); trying unauthenticated", base_url, exc)

    try:
        resp = httpx.get(url, headers=headers, timeout=timeout_seconds)
        if resp.status_code != 200:
            log.debug("probe %s -> %s", url, resp.status_code)
            return False
        if require_status_ok:
            try:
                body = resp.json()
            except Exception:  # noqa: BLE001 - non-JSON readiness = not ready
                return False
            if not isinstance(body, dict) or body.get("status") != "ok":
                log.debug("probe %s -> 200 but status=%s", url, body)
                return False
        return True
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.info("probe %s failed: %s", url, exc)
        return False


def vm_status() -> str:
    instance = compute_client().get(
        project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
    )
    return instance.status or "UNKNOWN"


def probe_jitsi_public() -> bool:
    """GET the public Jitsi origin (no auth) — true when nginx is serving.

    Distinguishes "GCP instance RUNNING" from "meeting UI is reachable".
    Cold VM boot: GCP flips to RUNNING while cloud-init still has tens of
    seconds of work; early clients then hit ERR_CONNECTION_REFUSED on
    external_api.js / wss://…/xmpp-websocket. We keep reporting starting
    until the first byte of HTTPS content arrives.
    """
    url = cfg.jitsi_public_url.rstrip("/") + "/"
    try:
        resp = httpx.get(url, timeout=cfg.jitsi_probe_timeout_seconds, follow_redirects=True)
        ready = resp.status_code == 200
        if not ready:
            log.debug("jitsi public probe %s -> %s", url, resp.status_code)
        return ready
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.debug("jitsi public probe %s failed: %s", url, exc)
        return False


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
@app.head("/")
def health_check() -> Response:
    """Lightweight health check for uptime monitors and platform probes."""
    return Response(content="OK", status_code=200)


@app.post("/start-jitsi")
def start_jitsi() -> dict[str, Any]:
    """Bring every meeting component up. Safe to call repeatedly.

    Returns ``already_running`` only when the VM is RUNNING **and** its
    public HTTPS origin is serving **and** both Cloud Run services answer
    their health endpoints; otherwise ``starting``.
    """
    components: dict[str, dict[str, str]] = {}

    # 1. Jitsi VM (JVB / Prosody / Jicofo)
    #    GCP RUNNING alone is not enough — also require the public HTTPS
    #    origin to answer, so clients never race nginx/prosody during boot.
    try:
        status = vm_status()
        if status == "RUNNING":
            if probe_jitsi_public():
                components["jvb"] = {"state": "ready"}
            else:
                log.info(
                    "%s: RUNNING but %s not serving yet",
                    cfg.instance_name,
                    cfg.jitsi_public_url,
                )
                components["jvb"] = {
                    "state": "starting",
                    "detail": "vm running; waiting for jitsi https",
                }
        else:
            log.info("%s: starting (status=%s)", cfg.instance_name, status)
            compute_client().start(
                project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
            )
            components["jvb"] = {"state": "starting", "detail": f"vm {status}"}
    except Exception as exc:  # noqa: BLE001 - report per-component errors
        log.exception("jvb start check failed")
        components["jvb"] = {"state": "error", "detail": str(exc)}

    # 2. Scale-to-zero Cloud Run services: the authenticated probe below is
    # what starts a cold instance (request-driven wake). We deliberately do
    # NOT touch min-instances - see the module docstring for the cost story.
    services = (
        # stt: /ready returns 200 while status=="loading" — require status ok.
        ("stt", cfg.stt_service_name, "/ready", cfg.stt_probe_timeout_seconds, True),
        ("proxy", cfg.proxy_service_name, "/health", cfg.proxy_probe_timeout_seconds, False),
    )
    for key, name, health_path, probe_timeout, require_ok in services:
        try:
            url = _service_url(name)
            ready = bool(url) and probe(url, health_path, probe_timeout, require_status_ok=require_ok)
            components[key] = {"state": "ready" if ready else "starting"}
        except Exception as exc:  # noqa: BLE001
            log.exception("%s wake failed", name)
            components[key] = {"state": "error", "detail": str(exc)}

    all_ready = all(c["state"] == "ready" for c in components.values())
    payload = {
        "status": "already_running" if all_ready else "starting",
        "components": components,
    }
    log.info("/start-jitsi -> %s %s", payload["status"], components)
    return payload


@app.post("/stop-jitsi")
def stop_jitsi():
    """Stop the billable VM.

    The Cloud Run services are intentionally left alone: they are
    request-driven and Cloud Run reaps their instances automatically once the
    meeting's WebSockets close (the STT service additionally closes sessions
    after an idle window). There is no resident-GPU state to clean up anymore.
    """
    components: dict[str, dict[str, str]] = {}
    stop_error: Exception | None = None

    try:
        status = vm_status()
        if status == "TERMINATED":
            components["jvb"] = {"state": "stopped"}
        else:
            log.info("%s: stopping (status=%s)", cfg.instance_name, status)
            compute_client().stop(
                project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
            )
            components["jvb"] = {"state": "stopping"}
    except Exception as exc:  # noqa: BLE001
        log.exception("jvb stop failed")
        components["jvb"] = {"state": "error", "detail": str(exc)}
        stop_error = exc

    for key, name in (("stt", cfg.stt_service_name), ("proxy", cfg.proxy_service_name)):
        components[key] = {"state": "scale-to-zero (automatic)"}

    all_down = components["jvb"]["state"] == "stopped"
    payload = {
        "status": "already_stopped" if all_down else ("error" if stop_error else "stopping"),
        "components": components,
    }
    log.info("/stop-jitsi -> %s", payload["status"])
    # Surface GCP failures as 5xx so the transcript-worker can retry instead
    # of logging "fired successfully" while the VM keeps billing.
    if stop_error is not None:
        return JSONResponse(status_code=500, content=payload)
    return payload


@app.get("/status")
def status() -> dict[str, Any]:
    """Read-only view of every component (no side effects beyond probes). For debugging."""
    components: dict[str, dict[str, str]] = {}
    try:
        vm = vm_status()
        if vm == "RUNNING" and probe_jitsi_public():
            components["jvb"] = {"state": "RUNNING", "https": "ready"}
        elif vm == "RUNNING":
            components["jvb"] = {"state": "RUNNING", "https": "not-ready"}
        else:
            components["jvb"] = {"state": vm}
    except Exception as exc:  # noqa: BLE001
        components["jvb"] = {"state": "error", "detail": str(exc)}

    for key, name, health_path, require_ok in (
        ("stt", cfg.stt_service_name, "/ready", True),
        ("proxy", cfg.proxy_service_name, "/health", False),
    ):
        try:
            url = _service_url(name)
            healthy = bool(url) and probe(
                url, health_path, cfg.stt_probe_timeout_seconds, require_status_ok=require_ok
            )
            components[key] = {
                "state": "ready" if healthy else "cold-or-starting",
                "url": url,
            }
        except Exception as exc:  # noqa: BLE001
            components[key] = {"state": "error", "detail": str(exc)}

    return {
        "project": cfg.project_id,
        "region": cfg.region,
        "jitsi_public_url": cfg.jitsi_public_url,
        "components": components,
    }
