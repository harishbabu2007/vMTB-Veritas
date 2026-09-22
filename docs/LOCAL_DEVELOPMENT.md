# Local Development & Testing Guide

How to run and test vMTB Veritas on your own machine — both the
meeting-transcription pipeline in isolation (no Docker, real GCS/Pub-Sub/
Supabase, a simulated JVB) and the full application flow against the real
`jitsi-vm` and activation backend. Merges the former `docs/LOCAL_DEV.md` and
`docs/LOCAL_TESTING.md`, which covered mostly the same five-terminal
transcription setup twice.

> **Known issue, flagged not silently fixed:** every Supabase URL/project-ID
> example below (`togobilqdevoyijxrexc`) is carried over unchanged from the
> two source docs. Per `docs/CLOUD_INVENTORY.md`, `togobilqdevoyijxrexc` is
> actually **`VMTB-Amala`, a different, unrelated Supabase project in the
> same org** — this repo's real project is `vMTB-Veritas`
> (`gwvqxetjheveelqrkjhg`). This same project-ID mix-up also appears
> hardcoded inside `main/supabase/migrations/20260801155807_remote_schema.sql`
> (see `docs/DATABASE_SCHEMA.md`'s "Known issue" section — that migration
> file is very likely where this confusion originated). **Use your own
> project's URL and project ref, not the ID shown in the example commands
> below**, until this is resolved.

## Architecture — who talks to whom

```
Browser (main app)
  │  create case / schedule MTB / "Start Meeting"
  ▼
main (local :5173, or deployed)
  │  POST /start-jitsi            ── polling until "already_running"
  ▼
jitsi-activation-backend (Cloud Run, vmtb-new/asia-southeast1 — see docs/CLOUD_INVENTORY.md)
  │  starts/stops Compute Engine VM "jitsi-vm" (asia-south1-c)
  ▼
Browser opens https://meet.vmtb.in/<room>  (jitsi-frontend, deployed)
  │  polls the same backend until the VM is up → embeds Jitsi
  ▼
JVB (inside the VM) ──WS (bridge transcription protocol)──▶ opus-transcriber-proxy
                                                              │ PCM16 @16kHz
                                                              ▼
                                                          stt-service (faster-whisper)
                                                              │ final segments
                                                              ▼
                                                          Supabase (meeting_transcripts + segments)
                                                              │ meeting.completed
                                                              ▼
                                                          Pub/Sub ──▶ transcript-worker ──▶ GCS + (LLM MoM)
```

**Key clarification:** the activation backend **never talks to the proxy**.
It only starts/stops the VM. The **only** thing that talks to the proxy is
the JVB running inside the GCP VM.

## Why the JVB can't reach your laptop's proxy

The JVB runs inside a GCP VM; your proxy listens on `localhost:8080`; the VM
cannot reach `localhost` on your machine. Two ways around this:

| Option | What it is | When to use |
|---|---|---|
| **JVB simulator** | A script that speaks the JVB protocol locally (streams real Opus audio) | Default — tests the whole pipeline with no Jitsi, no VM, no network |
| **Tunnel** (`cloudflared`) | Exposes your local proxy at a public `wss://` URL that the VM's Jicofo connects to | Advanced — a real Jitsi meeting with live transcription |

## What you can test locally

| Thing to test | Fully local? | How |
|---|---|---|
| Transcription pipeline (proxy → STT → Supabase → Pub/Sub → worker → GCS) | ✅ | JVB simulator (Part 2) |
| STT accuracy (real faster-whisper, multilingual) | ✅ | Same — it's a real model on your machine |
| Meeting orchestration (create case → schedule MTB → start meeting → join) | ✅ UI local, backend/VM real | `main` locally + real activation backend + real VM (Part 3) |
| Real Jitsi meeting **with** transcription | ⚠️ needs tunnel + VM config | Part 4 (advanced) |

---

## Part 0 — One-time setup

1. **Apply the Supabase migration** — run
   `main/supabase/migrations/20260820_meeting_transcripts.sql` in your
   project's SQL Editor (Dashboard → SQL Editor → paste → Run), or via the
   Management API with a personal access token:
   ```bash
   curl -sS -X POST \
     "https://api.supabase.com/v1/projects/<YOUR_PROJECT_REF>/database/query" \
     -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" \
     -d "{\"query\": $(jq -Rs . < main/supabase/migrations/20260820_meeting_transcripts.sql)}"
   ```
2. **Service role key** — Dashboard → Project Settings → API →
   `service_role`. Full DB access — never commit it or expose it in a
   frontend build. Needed in the proxy/worker `.env` files below.
3. **GCP one-time setup** (project `vmtb-new`):
   ```bash
   gcloud auth login && gcloud config set project vmtb-new
   gcloud storage buckets create gs://vmtb-new-transcripts --location=asia-southeast1
   gcloud pubsub topics create meeting-transcripts
   # Push subscription — used by the real deployed Cloud Run worker only; not needed for local dev:
   gcloud pubsub subscriptions create meeting-transcripts-push \
     --topic=meeting-transcripts \
     --push-endpoint=https://transcript-worker.<region>.run.app/pubsub/push \
     --push-auth-service-account=transcript-worker-sa@vmtb-new.iam.gserviceaccount.com
   # Pull subscription — used by the LOCAL dev loop (a forwarder script pulls from
   # this and POSTs to your local worker, since push can't reach localhost):
   gcloud pubsub subscriptions create meeting-transcripts-local --topic=meeting-transcripts
   ```
4. **ADC for local Pub/Sub + GCS:** `gcloud auth application-default login`
   (the proxy publishes and the local forwarder pulls using ADC — no
   service-account JSON needed on your dev machine).

### Env files

`opus-transcriber-proxy/.env` (`cp .env.example .env` first):

| Variable | Local value |
|---|---|
| `PROVIDER` | `self-hosted` |
| `STT_WS_URL` | `ws://localhost:9090/client/ws/speech` |
| `PERSISTENCE` | `supabase` |
| `SUPABASE_URL` | your project's URL (**not** `togobilqdevoyijxrexc` — see the flag above) |
| `SUPABASE_SERVICE_ROLE_KEY` | your `service_role` key |
| `GCP_PROJECT_ID` | `vmtb-new` |
| `PUBSUB_TOPIC` | `meeting-transcripts` |
| `PUBSUB_EMULATOR_HOST` | *(leave empty)* |

`transcript-worker/.env` (`cp .env.example .env` first):

| Variable | Local value |
|---|---|
| `SUPABASE_URL` | your project's URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your `service_role` key |
| `GCS_BUCKET` | `vmtb-new-transcripts` |
| `GCP_PROJECT_ID` | `vmtb-new` |
| `PUBSUB_PUSH_TOKEN` | *(empty = disabled, fine for local)* |
| `LLM_PROVIDER` | `none` (skip MoM) — or `gemini`/`openai` with `LLM_API_KEY` to test MoM generation |

`stt-service` needs no `.env` for defaults (`STT_MODEL=medium`,
multilingual). For a fast local CPU run:
```bash
export STT_MODEL=base   # tiny/base are much faster on CPU; medium is the production default
export STT_DEVICE=cpu   # auto-selects cuda if available
```

`main/.env` should already have real `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, and `VITE_JITSI_BACKEND_URL` — nothing to change
for local runs.

---

## Part 1 — Test the transcription pipeline (no Jitsi needed)

Five terminals (`npm install` once in `opus-transcriber-proxy/` and
`transcript-worker/` if not already done):

```bash
# T1 — STT
cd stt-service && uv sync && uv run python -m app.main        # :9090

# T2 — proxy
cd opus-transcriber-proxy && npm run dev                       # :8080

# T3 — worker
cd transcript-worker && npm run dev                            # :8080

# T4 — Pub/Sub pull forwarder (bridges real Pub/Sub → local worker)
cd transcript-worker && npm run local:pull

# T5 — pretend to be the JVB: streams ~4s of real Opus audio (sine-wave fixture), then closes
cd opus-transcriber-proxy && npm run simulate:jvb
```

### Verify

After `simulate:jvb` finishes, in order:
1. **STT (`:9090`)** — proxy log shows `conn: started` and STT round-trips.
2. **Proxy (`:8080`)** — log shows `session: closing` and `pubsub: publishing`.
3. **Pub/Sub** — the forwarder prints `POST http://localhost:8080/pubsub/push 200`.
4. **Worker (`:8080`)** — log shows the meeting claimed, GCS upload, and
   `complete_meeting_transcript` succeeded.
5. **Supabase** (SQL Editor):
   ```sql
   select * from meeting_transcripts order by created_at desc limit 5;
   select * from meeting_transcript_segments order by created_at desc limit 10;
   ```
   `meeting_transcripts.status` should be `COMPLETED` with segment rows present.
6. **GCS:**
   ```bash
   gcloud storage ls gs://vmtb-new-transcripts/meetings/
   # → meetings/<sessionId>/transcript/transcript-v1.json + transcript-v1.txt
   ```

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Proxy `pubsub: publishing disabled` | `GCP_PROJECT_ID`/`PUBSUB_TOPIC` not set, or no ADC — run `gcloud auth application-default login` |
| Forwarder `pull failed: ...` | Not authed (ADC), or the pull subscription is missing — redo Part 0 step 3 |
| Worker `401` on `/pubsub/push` | `PUBSUB_PUSH_TOKEN` mismatch — leave it empty locally |
| `meeting_transcripts.status = FAILED` | Worker logged the reason in its terminal; retry-safe, the meeting is claimed once |
| Empty/odd transcript | Expected — the fixture is a **440 Hz sine tone** (no speech), so it exercises the pipeline, not ASR accuracy |
| STT slow on CPU | Use `STT_MODEL=base` for local testing; `medium` is the production default |

Do **not** run `simulate:jvb` with `PROVIDER=dummy` unless the STT service is
off — it's a smoke test that skips real transcription.

---

## Part 2 — Test meeting orchestration (main app + real Jitsi VM)

This tests the real user flow against the live activation backend and real
`jitsi-vm` — **the VM will actually boot** and bill while running; stop it
when done.

1. `cd main && npm install && npm run dev` → `http://localhost:5173`
2. Log in, create a case, schedule an MTB, click **Start Meeting**.
3. Watch the flow: `main` POSTs `/start-jitsi` to the activation backend and
   polls until `already_running` twice (90s cap); the backend boots
   `jitsi-vm` (~1 min); `main` opens `https://meet.vmtb.in/<room>`, which
   polls the backend again and embeds the real Jitsi meeting.
4. Optionally run `jitsi-frontend` locally instead of the deployed one:
   ```bash
   cd jitsi-frontend && cp .env.production .env.development && npm install && npm run dev
   # then point main/src/services/meeting.ts's Jitsi URL at http://localhost:5174
   ```
5. **Stop the VM when done**, using your activation backend's actual URL —
   verify it in `docs/CLOUD_INVENTORY.md` rather than assuming a hostname:
   ```bash
   curl -X POST <ACTIVATION_BACKEND_URL>/stop-jitsi
   ```

**What this validates:** case → MTB → meeting orchestration, VM start/stop,
real Jitsi join. **What it does NOT validate:** transcription, unless the
JVB on the VM is wired up per `docs/JITSI_TRANSCRIPTION_CONFIG.md`.

---

## Part 3 — Real Jitsi meeting WITH transcription (advanced)

Only once you want the real JVB talking to your local proxy:

1. Apply the JVB-side config on the VM per `docs/JITSI_TRANSCRIPTION_CONFIG.md`.
2. Expose your local proxy with a tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   # prints something like: https://random-words.trycloudflare.com
   ```
3. Point Jicofo's `transcription.url-template` at
   `wss://random-words.trycloudflare.com/transcribe?sessionId={{MEETING_ID}}&sendBack=true`,
   restart Jicofo/JVB, start a real meeting, enable transcription in the UI.

**Caveats:** the quick tunnel URL changes on every `cloudflared` restart —
restart Jicofo each time, or use a named tunnel. The VM must be running for
the meeting to exist. Only worth doing after Part 1 works.

---

## Part 4 — Does the STT service cost money when idle?

**Not while testing locally** — it runs on your machine and isn't deployed
anywhere. Once deployed to Cloud Run:

| Deployment | Idle behavior | Cost |
|---|---|---|
| Cloud Run **GPU** (L4), `--min-instances=0` | Scales to zero when no transcription session is open | ~$0 idle; cold start ~1 min on the first call after idle |
| Cloud Run **GPU**, `--min-instances=1` | Always warm | Very expensive — not worth it for an MVP |
| Cloud Run **CPU-only**, `--min-instances=0` | Scales to zero | ~$0 idle, but `medium` is too slow for streaming on CPU — use `base`/`small` |
| Not deployed | — | Nothing |

The confirmed-live setup uses GPU with `--min-instances=0` (see
`docs/JITSI_VM_OPERATIONS.md` for the fuller idle-GPU-billing story and why
`jitsi-activation-backend` never patches Cloud Run scaling directly).
