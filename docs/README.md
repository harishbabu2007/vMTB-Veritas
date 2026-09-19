# vMTB Veritas — Documentation Index

Start here. This folder holds every cross-cutting architecture, deployment,
and workflow doc for the project — one file per independent topic, each
detailed enough to stand alone. Per-service `README.md` files (`main/`,
`jitsi-frontend/`, `opus-transcriber-proxy/`, `stt-service/`,
`transcript-worker/`) stay in their own directories; everything else lives
here. See the root `CLAUDE.md` for a shorter orientation pass and how this
repo is structured as a monorepo.

## Ground truth / start here

- **[`CLOUD_INVENTORY.md`](CLOUD_INVENTORY.md)** — read this before touching
  any AWS/GCP/Supabase infrastructure or assuming what's deployed where. The
  confirmed, as-queried map of what exists, what's this project vs.
  unrelated shared-account clutter, and the GCP old-vs-new project split.

## Application (`main/`)

- **[`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md)** — every Postgres table and
  view, column-by-column, plus which tables actually enforce RLS (only 3 of
  19) and a flagged committed-secret finding.
- **[`DOCUMENT_AI_PIPELINE.md`](DOCUMENT_AI_PIPELINE.md)** — how an uploaded
  case document becomes an anonymized, AI-summarized report: the AWS Lambda
  chain, S3 layout, Bedrock models, exactly where files/summaries end up
  stored, and how owner edits are committed and processed as pipeline runs.
- **[`AUTH_AND_NOTIFICATIONS.md`](AUTH_AND_NOTIFICATIONS.md)** — Google
  OAuth / phone+password / WhatsApp OTP login flows, and the notification
  Edge Functions.
- **[`CASE_AND_MTB_WORKFLOW.md`](CASE_AND_MTB_WORKFLOW.md)** — the case
  creation wizard, case viewing/collaboration, MTB pages, and meeting
  launch. Also where patient age/sex come from (the documents, not the
  user), the age/sex-gated verification flow, first-verification tab
  locking, and the capped regenerate action. Also the first-time guided
  walkthrough, its sample case and sample board, and its tips.

## Meeting & transcription pipeline

- **[`MEETING_TRANSCRIPTION_PIPELINE.md`](MEETING_TRANSCRIPTION_PIPELINE.md)** —
  end-to-end data flow (JVB → proxy → STT → Supabase → Pub/Sub → worker),
  the status-machine RPCs, and per-service env vars.
- **[`JITSI_VM_OPERATIONS.md`](JITSI_VM_OPERATIONS.md)** — day-to-day
  `jitsi-vm` start/stop, the custom-domain migration, and the idle-GPU
  billing story.
- **[`JITSI_TRANSCRIPTION_CONFIG.md`](JITSI_TRANSCRIPTION_CONFIG.md)** —
  Prosody/Jicofo/`config.js` wiring needed on the VM for transcription.
- **[`GPU_ACCESS_MUMBAI.md`](GPU_ACCESS_MUMBAI.md)** — standing runbook for
  requesting Mumbai L4 GPU access. **Not yet executed** — services remain in
  Singapore (`asia-southeast1`).

## Deploying and developing

- **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — the one guide to take an empty
  cloud account to a fully working platform: GCP setup, all 4 backend
  Cloud Run services, frontends, CI/CD, cost minimization, troubleshooting.
- **[`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md)** — run the
  transcription pipeline and/or the full app locally without Docker.

## Before you trust anything

- **[`LEGACY_AND_KNOWN_ISSUES.md`](LEGACY_AND_KNOWN_ISSUES.md)** — do-not-touch
  legacy code, dead code paths, standing security findings, and which
  stale docs elsewhere in the repo are known-bad and left in place
  deliberately.
