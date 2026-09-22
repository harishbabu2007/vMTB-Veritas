# transcript-worker

Post-meeting transcript worker for the vMTB transcription pipeline. Triggered by
a Google Cloud Pub/Sub push subscription, it:

1. **claims** a meeting (idempotent, atomic `PENDING → PROCESSING` via
   `claim_meeting_transcript`) — the worker's idempotency lock
2. **reads** the ordered final transcript segments from Supabase
3. **uploads** transcript artifacts to Google Cloud Storage
   (`gs://<bucket>/meetings/<meeting_id>/transcript/transcript-v1.{json,txt}`)
4. **generates** AI Minutes-of-Meeting via any OpenAI-compatible endpoint
   (optional — production uses Gemini Flash-Lite)
5. **completes** the meeting (`PROCESSING → COMPLETED` with the GCS object key
   and MoM stored back in Supabase)

On any processing error the meeting is marked `FAILED` (with the reason) and the
push is *acked*: retrying an immutable past meeting will not fix it, so we record
the failure instead. Only infra failures (e.g. Supabase unreachable during the
claim) return a non-200 so Pub/Sub redelivers.

```
Pub/Sub ──push──▶ transcript-worker
                    │ claim (Supabase RPC)        idempotency lock
                    │ segments (Supabase)         ordered transcript
                    │ artifacts (GCS)             transcript-v1.json/.txt
                    │ MoM (LLM)                   OpenAI-compatible (Gemini), optional
                    │ complete (Supabase RPC)     status + object key + MoM
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /pubsub/push` | Pub/Sub push endpoint (Bearer-token protected) |

The push body is the standard Pub/Sub delivery envelope; the base64 `message.data`
is our JSON `{"event":"meeting.completed","meeting_id":"...","mtb_id":null}`.
Only `meeting.completed` events are processed; anything else is acked and ignored.

## Idempotency

- The claim is an atomic `UPDATE ... WHERE status='PENDING' RETURNING *`; a
  concurrent or redelivered message cannot win twice.
- If no PENDING row exists (`already-processed`), the message is acked with no
  work — safe for Pub/Sub at-least-once delivery.
- `COMPLETED`/`FAILED` rows are never re-processed.

## Configuration

See `.env.example`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Bind address/port |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Required (service role) |
| `GCS_BUCKET` | — | Required. Bucket for transcript artifacts |
| `GCP_PROJECT_ID` | — | GCP project (for ADC lookup; empty = use default) |
| `PUBSUB_PUSH_TOKEN` | *(empty)* | Bearer token configured on the push subscription. Empty disables auth (dev only) |
| `LLM_PROVIDER` | `none` | `none`, `gemini`, or any OpenAI-compatible provider name |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Base URL for `/chat/completions` (Gemini OpenAI-compatible) |
| `LLM_API_KEY` | — | Required to enable MoM generation (Gemini API key) |
| `LLM_MODEL` | `gemini-2.5-flash-lite` | Cheap Flash-Lite model for MoM |

GCS authentication uses Application Default Credentials (Cloud Run's attached
service account), so no key file is configured.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## Tests

- `tests/auth.test.ts` — push bearer-token verification
- `tests/worker.test.ts` — claim / already-processed / success / failure paths
  with fakes; GCS upload, LLM MoM generation and artifact shape
- `tests/server.test.ts` — full HTTP push endpoint: auth, malformed bodies,
  ack vs nack, health

## Container

```bash
docker build -t transcript-worker .
docker run --rm -p 8080:8080 \
  -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e GCS_BUCKET=... -e PUBSUB_PUSH_TOKEN=... \
  transcript-worker
```

## Design notes

- **Ack-on-failure**: meeting-level failures are recorded (FAILED) and acked;
  only infra failures nack for redelivery.
- **No secrets in code/logs**: the service role key lives in env only; pino
  redaction strips transcripts/MoM/authorization from logs.
- **MoM is best-effort**: if the LLM is not configured, meetings complete with a
  null MoM rather than failing.
- **Artifact versioning**: the version is in the object key and the row
  (`transcript_version`), so a future re-generation writes
  `transcript-v2.json` without overwriting v1.