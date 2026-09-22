# Meeting Transcription Pipeline — Architecture

Bridge-based transcription for Jitsi meetings in the vMTB Veritas platform.
Audio stays inside GCP; nothing audio-related leaves the project.

This is entirely separate from the document-AI pipeline
(`docs/DOCUMENT_AI_PIPELINE.md`), which anonymizes/summarizes *uploaded case
documents* and shares nothing with this pipeline. See also
`docs/JITSI_VM_OPERATIONS.md` (VM lifecycle, custom domain, cost model),
`docs/JITSI_TRANSCRIPTION_CONFIG.md` (Prosody/Jicofo wiring on the VM), and
`docs/GPU_ACCESS_MUMBAI.md` (standing GPU-region runbook — not yet executed;
these services currently run in `asia-southeast1`/Singapore).

```
                              ┌────────────────────────────────────────────┐
                              │                    GCP                      │
                              │                                            │
 Jitsi Video Bridge (JVB)     │                                            │
 (external, live on the VM)   │                                            │
 ───────────WS────────────────▶  opus-transcriber-proxy   (Cloud Run)      │
    JVB protocol:             │        │ decode Opus → PCM16 16k mono      │
    ping / start / media      │        │ per-participant STT connection    │
    (base64 Opus frames)      │        ▼                                   │
                              │  stt-service             (Cloud Run GPU)   │
                              │  faster-whisper (multilingual, medium)     │
                              │        │ partial / final segments          │
                              │        ▼                                   │
                              │  Supabase                                   │
                              │  meeting_transcript_segments (FINAL only)   │
                              │        │  meeting ends (WS close)           │
                              │        ▼                                   │
                              │  Pub/Sub  meeting.completed                 │
                              │        │  push                             │
                              │        ▼                                   │
                              │  transcript-worker       (Cloud Run)       │
                              │  claim → GCS artifacts → LLM MoM → COMPLETED│
                              └────────────────────────────────────────────┘
```

## Components

| Component | Language | Where it lives | Job |
|---|---|---|---|
| JVB (external) | — | not in this repo | Owns the meeting; speaks the bridge-based transcription protocol |
| `opus-transcriber-proxy` | TypeScript | `opus-transcriber-proxy/` | Accepts one WebSocket per meeting, decodes participant-tagged Opus → PCM16, streams to STT, persists final segments, publishes the completion event |
| `stt-service` | Python/FastAPI | `stt-service/` | WhisperLive-compatible streaming endpoint backed by faster-whisper (multilingual `medium`), committed-prefix streaming policy |
| Supabase | SQL | `main/supabase/migrations/20260820_meeting_transcripts.sql` | `meeting_transcripts` (status, GCS key, MoM) + `meeting_transcript_segments` (final segments) + RPCs |
| `transcript-worker` | TypeScript | `transcript-worker/` | Claims meetings idempotently, uploads artifacts to GCS, generates MoM via an OpenAI-compatible LLM, marks COMPLETED |
| Google Cloud | — | infra | Cloud Run (+GPU), Pub/Sub, GCS, Artifact Registry, Secret Manager |

## Identity model

`meeting_id` is the JVB transcription session id: the value Jicofo substitutes
into `jicofo.transcription.url-template` for `{{MEETING_ID}}`. It is an opaque
TEXT (the Jitsi conference meeting id) and is **not** `meeting_sessions.id` and
**not** `mtb_id`. `mtb_id` is NULL in the MVP. Reconcile later via Prosody room
metadata or a join on room name + start window.

## Data flow, in detail

1. **Start.** A user clicks *Start meeting* in `main/` → `jitsi-frontend`
   MeetingPage polls `POST /start-jitsi` (existing `jitsi-activation-backend`)
   and joins `meet.vmtb.in/<room>`. JVB begins transcription (see
   `docs/JITSI_TRANSCRIPTION_CONFIG.md` for the JVB-side wiring) and opens
   `ws://<proxy>/transcribe?sessionId={{MEETING_ID}}&sendBack=true`.

2. **Real time.** JVB sends `start`/`media` events. The proxy creates one
   OutgoingConnection per participant tag (own Opus decoder + own STT
   connection), decodes to mono PCM16 @ 16 kHz, and forwards in 60 ms chunks.
   `stt-service` transcribes with a committed-prefix policy: it emits
   `partial` for the unstable tail and `final` for committed, non-overlapping
   segments. The proxy persists **only `final` segments** to Supabase and, when
   `sendBack=true`, echoes results to JVB for captions.

3. **Failure isolation.** STT / Supabase / Pub/Sub failures are logged and
   swallowed by the proxy — transcription degrades but never breaks the
   meeting. No raw audio is ever stored; audio exists only in memory.

4. **End of meeting.** JVB closes the WebSocket. The proxy ensures the
   `meeting_transcripts` row exists (PENDING), then publishes
   `meeting.completed {meeting_id, mtb_id:null}` to Pub/Sub.

5. **Post-processing.** `transcript-worker` (triggered by the Pub/Sub push
   subscription) atomically claims the meeting (`PENDING → PROCESSING`), reads
   the ordered segments, uploads `transcript-v1.json`/`.txt` to
   `gs://<bucket>/meetings/<meeting_id>/transcript/`, optionally generates MoM
   via LLM, then marks `COMPLETED` with the object key and MoM. Failures are
   recorded as `FAILED` and acked; only infra failures nack for redelivery.

## Status machine

```
                proxy (ensure)         worker (claim)        worker
   (none) ──▶ PENDING ────────────▶ PROCESSING ──────────▶ COMPLETED
                                        │                     
                                        └─(error)──▶ FAILED
```

- `ensure_meeting_transcript` — idempotent insert (proxy)
- `claim_meeting_transcript` — atomic PENDING→PROCESSING lock (worker)
- `complete_meeting_transcript` — PROCESSING→COMPLETED (worker)
- `fail_meeting_transcript` — PROCESSING→FAILED (worker)

All transitions are single-source-of-truth RPCs, so the proxy and worker can
never disagree about a meeting's state.

## Storage

- **Supabase** holds the live segment table (used by realtime/UI) and the
  meeting-level row with the GCS pointer + MoM.
- **GCS** holds the canonical, versioned artifacts:
  `meetings/<meeting_id>/transcript/transcript-v{version}.{json,txt}`.

## Environment variables (all 3 services)

### `opus-transcriber-proxy`

| Var | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Bind |
| `LOG_LEVEL` | `info` | pino log level |
| `PROVIDER` | `self-hosted` | `self-hosted` or `dummy` (offline/local-dev provider) |
| `STT_WS_URL` | — | WS URL of `stt-service` (required for `self-hosted`) |
| `STT_SAMPLE_RATE` | `16000` | PCM sample rate sent to STT |
| `STT_CHUNK_MS` | `60` | ms of PCM buffered before forwarding |
| `STT_USE_ID_TOKEN` | `false` | Attach a Google ID token to the STT WS connection (for a non-public STT deploy) |
| `PERSISTENCE` | `supabase` | `supabase` or `none` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Required when `PERSISTENCE=supabase` |
| `GCP_PROJECT_ID`, `PUBSUB_TOPIC` | — | For publishing `meeting.completed` |
| `PUBSUB_EMULATOR_HOST` | — | Local Pub/Sub emulator override |
| `MAX_SESSION_ID_LENGTH` | `128` | Session id length guard |

### `stt-service`

| Var | Default | Purpose |
|---|---|---|
| `STT_HOST` / `STT_PORT` | `0.0.0.0` / `9090` | Bind |
| `STT_LOG_LEVEL` | `info` | uvicorn log level |
| `STT_MODEL` | `medium` | Whisper model size — multilingual, required for Indian-language support; do not swap in `small.en` |
| `STT_LANGUAGE` | *(auto)* | Force a language code |
| `STT_BEAM_SIZE` | `1` | Beam size |
| `STT_SAMPLE_RATE` | `16000` | Expected PCM sample rate |
| `STT_CHUNK_SECONDS` | `0.3` | Min audio between transcription runs |
| `STT_MIN_COMMIT_WORDS` | `2` | Min words before committing a prefix |
| `STT_MAX_BUFFER_SECONDS` | `600` | Hard cap on in-memory audio buffer |
| `STT_MAX_RUN_GAP_SECONDS` | `5.0` | Max wall-clock gap forcing a transcription run |
| `STT_IDLE_TIMEOUT_SECONDS` | `300` | Close the WS after this many seconds of silence (`0` disables) — prevents an orphaned connection holding a billable GPU |
| `STT_DEVICE` | `auto` | `auto`/`cpu`/`cuda` |
| `STT_COMPUTE_TYPE` | `auto` | `auto` (→ float16 GPU / int8 CPU) / `float16` / `int8` / `float32` |

### `transcript-worker`

| Var | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Bind |
| `LOG_LEVEL` | `info` | pino level |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Required |
| `GCS_BUCKET` | — | Required; transcript artifact bucket |
| `GCP_PROJECT_ID` | `""` | ADC project hint |
| `PUBSUB_PUSH_TOKEN` | `""` (disables auth) | Must match the push subscription's token |
| `LLM_PROVIDER` | `none` | `none`, `gemini`, or an OpenAI-compatible provider name |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Chat-completions base URL. **Confirmed live value: Gemini OpenAI-compatible endpoint** (design remains provider-agnostic; production runs Gemini) |
| `LLM_API_KEY` | — | Required to enable MoM generation (Gemini API key from AI Studio, stored as Secret Manager `llm-api-key`) |
| `LLM_MODEL` | `gemini-2.5-flash-lite` | **Confirmed live value: cheap Gemini Flash-Lite model** for MoM |
| `JITSI_ACTIVATOR_URL` | `""` (disabled) | After completing a meeting, POSTs `{url}/stop-jitsi` so the VM isn't left billing — see `docs/JITSI_VM_OPERATIONS.md` |

## Trade-offs and notes

- **Only FINAL segments are stored** in Supabase — clean, non-duplicated
  utterance records; interim results live only in proxy memory.
- **Artifacts are generated post-meeting**, not during it, keeping the
  real-time path minimal.
- **MoM is best-effort** — LLM config is optional; meetings complete with a
  null MoM when no LLM is configured.
- **MVP scope**: `mtb_id` NULL, JVB not run inside this repo, no realtime UI
  wiring yet (the segments table is already in the `supabase_realtime`
  publication for a future live-transcript feature).