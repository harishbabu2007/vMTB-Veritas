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


def probe(base_url: str, path: str, timeout_seconds: float) -> bool:
    """GET a health endpoint, authenticating with an ID token when possible.

    The probe doubles as the scale-from-zero trigger: Cloud Run starts an
    instance to serve it. A cold STT instance may not answer within the first
    few attempts (model load); callers simply poll again.
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
        ok = resp.status_code == 200
        log.debug("probe %s -> %s", url, resp.status_code)
        return ok
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.info("probe %s failed: %s", url, exc)
        return False


def vm_status() -> str:
    instance = compute_client().get(
        project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
    )
    return instance.status or "UNKNOWN"


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

    Returns ``already_running`` only when the VM is RUNNING **and** both Cloud
    Run services answer their health endpoints; otherwise ``starting``.
    """
    components: dict[str, dict[str, str]] = {}

    # 1. Jitsi VM (JVB / Prosody / Jicofo)
    try:
        status = vm_status()
        if status == "RUNNING":
            components["jvb"] = {"state": "ready"}
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
        ("stt", cfg.stt_service_name, "/ready", cfg.stt_probe_timeout_seconds),
        ("proxy", cfg.proxy_service_name, "/health", cfg.proxy_probe_timeout_seconds),
    )
    for key, name, health_path, probe_timeout in services:
        try:
            url = _service_url(name)
            state = "ready" if (url and probe(url, health_path, probe_timeout)) else "starting"
            components[key] = {"state": state}
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
def stop_jitsi() -> dict[str, Any]:
    """Stop the billable VM.

    The Cloud Run services are intentionally left alone: they are
    request-driven and Cloud Run reaps their instances automatically once the
    meeting's WebSockets close (the STT service additionally closes sessions
    after an idle window). There is no resident-GPU state to clean up anymore.
    """
    components: dict[str, dict[str, str]] = {}

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

    for key, name in (("stt", cfg.stt_service_name), ("proxy", cfg.proxy_service_name)):
        components[key] = {"state": "scale-to-zero (automatic)"}

    all_down = components["jvb"]["state"] == "stopped"
    payload = {
        "status": "already_stopped" if all_down else "stopping",
        "components": components,
    }
    log.info("/stop-jitsi -> %s", payload["status"])
    return payload


@app.get("/status")
def status() -> dict[str, Any]:
    """Read-only view of every component (no side effects beyond probes). For debugging."""
    components: dict[str, dict[str, str]] = {}
    try:
        components["jvb"] = {"state": vm_status()}
    except Exception as exc:  # noqa: BLE001
        components["jvb"] = {"state": "error", "detail": str(exc)}

    for key, name, health_path in (
        ("stt", cfg.stt_service_name, "/ready"),
        ("proxy", cfg.proxy_service_name, "/health"),
    ):
        try:
            url = _service_url(name)
            healthy = bool(url) and probe(url, health_path, cfg.stt_probe_timeout_seconds)
            components[key] = {
                "state": "ready" if healthy else "cold-or-starting",
                "url": url,
            }
        except Exception as exc:  # noqa: BLE001
            components[key] = {"state": "error", "detail": str(exc)}

    return {"project": cfg.project_id, "region": cfg.region, "components": components}
