# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It's meant to be the complete, current index — a new team member or an AI agent should be able to get the full picture of this project from this file plus `docs/` alone, without re-deriving anything from source.

This repo also has a root `AGENTS.md` — kept intentionally short, as a pointer to this file and `docs/` for tools that look for `AGENTS.md` by convention. This file is the one kept detailed and current.

**Before touching AWS/GCP infrastructure or assuming what's deployed where, read `docs/CLOUD_INVENTORY.md`.** The Supabase/AWS/GCP accounts behind this repo are shared with unrelated projects (a "PGx" pharmacogenomics project, a couple of other GCP projects) — that doc records exactly what's in scope, what to ignore, and — most importantly — that **GCP is mid-migration across two projects** (`vmtb` = old, still hosts the document-anonymization pipeline; `vmtb-new` = current, hosts the live meeting/transcription pipeline). Don't assume a resource lives in the project you happen to be looking at.

## Project Overview

**vMTB Veritas** is a virtual Molecular Tumor Board platform: multidisciplinary oncology teams collaborate on cancer cases, review genomic profiles, and run structured case discussions, including live video MTB meetings with automatic transcription and AI-generated minutes. The repo is a monorepo consolidating what used to be three separate repositories (`main`, the Jitsi meeting services, and the transcription pipeline).

## Repository Structure

- **`main/`** — the primary clinical web app (React 18 + TypeScript + Vite, backed by Supabase). This is where almost all day-to-day feature work happens.
- **`jitsi-activation-backend/`** — FastAPI service that brings up every billable meeting component on demand: starts/stops the GCP Compute Engine VM (`jitsi-vm`, `asia-south1-c`) hosting Jitsi, and issues authenticated health probes against `stt-service`/`opus-transcriber-proxy` — the probe itself wakes those Cloud Run services from scale-to-zero. It never touches Cloud Run `min-instances` config (a past design that did caused an idle GPU to bill for days when the "scale back to 0" step was missed — see the module docstring in `main.py`, and `docs/JITSI_VM_OPERATIONS.md`). **Live deployment is a Cloud Run service in the `vmtb-new` GCP project (`asia-southeast1`)** — confirmed current as of this writing; treat any mention of Render hosting for this service elsewhere as historical/stale.
- **`jitsi-frontend/`** — separate React/Vite app at `meet.vmtb.in`; polls the activation backend until the VM is ready, then hosts the actual meeting.
- **`opus-transcriber-proxy/`** — TypeScript Cloud Run service sitting between Jitsi's videobridge (JVB) and STT: decodes per-participant Opus audio to PCM16, streams it to `stt-service`, persists final transcript segments to Supabase, publishes `meeting.completed` to Pub/Sub.
- **`stt-service/`** — Python FastAPI, Cloud Run GPU. WhisperLive-compatible WebSocket STT backed by faster-whisper (multilingual `medium` model — required for Indian-language support; do not swap in `small.en`).
- **`transcript-worker/`** — TypeScript Cloud Run service triggered by Pub/Sub push; assembles a meeting's transcript segments, uploads to GCS, generates Minutes-of-Meeting via Mistral (`mistral-small-latest`, confirmed live — the code itself is OpenAI-compatible/provider-agnostic), marks the job complete in Supabase.
- **`docs/`** — every cross-cutting architecture/deployment/workflow doc lives here now, one file per independent topic. See **`docs/README.md`** for the full index; the short version:
  - `CLOUD_INVENTORY.md` — ground truth for what's deployed where (read first).
  - `DATABASE_SCHEMA.md`, `DOCUMENT_AI_PIPELINE.md`, `AUTH_AND_NOTIFICATIONS.md`, `CASE_AND_MTB_WORKFLOW.md` — the `main/` app in depth.
  - `MEETING_TRANSCRIPTION_PIPELINE.md`, `JITSI_VM_OPERATIONS.md`, `JITSI_TRANSCRIPTION_CONFIG.md`, `GPU_ACCESS_MUMBAI.md` — the meeting/transcription side.
  - `DEPLOYMENT.md`, `LOCAL_DEVELOPMENT.md` — getting it running, from scratch or locally.
  - `LEGACY_AND_KNOWN_ISSUES.md` — do-not-touch code, dead paths, standing security findings.
- Top-level `supabase/` is just local Supabase CLI state — the real schema/migrations/functions live under `main/supabase/`.

Each service has its own env config and is deployed independently: Vercel for the two frontends, Cloud Run (`vmtb-new` GCP project) for `jitsi-activation-backend` and the three transcription services. See `docs/CLOUD_INVENTORY.md` for the confirmed live-resource inventory.

## Commands

Run these from inside each service's directory (there is no root-level install/build).

| Service | Install | Dev | Build | Typecheck / Lint / Test |
|---|---|---|---|---|
| `main/` | `npm install` | `npm run dev` | `npm run build` | `npm run typecheck`, `npm run lint` |
| `jitsi-frontend/` | `npm install` | `npm run dev` | `npm run build` (runs `tsc` first) | `npm run lint` |
| `jitsi-activation-backend/` | `pip install -r requirements.txt` | `uvicorn main:app --reload` | — | — |
| `opus-transcriber-proxy/` | `npm install` | `npm run dev` (tsx watch) | `npm run build` | `npm run typecheck`, `npm test` (vitest), `npm run test:watch` |
| `stt-service/` | `uv sync` | `uv run python -m app.main` | — | `uv run python -m pytest tests/ -q` |
| `transcript-worker/` | `npm install` | `npm run dev` (tsx watch) | `npm run build` | `npm run typecheck`, `npm test` (vitest), `npm run test:watch` |

To run a single test file with vitest: `npm test -- path/to/file.test.ts`. To run a single pytest test: `uv run python -m pytest tests/test_streaming.py::test_name -q`.

`main/` has no test suite — verification there is `npm run typecheck` + `npm run lint` + manual/browser checking.

## Architecture

### `main/` app structure

- Entry: `src/main.tsx` → `src/App.tsx`. Routing is React Router v7; providers nest as `AuthProvider` → `CasesProvider` → `CaseCreationProvider`, wrapping `<Routes>`. Auth/signup/password-reset routes are public; everything else (`my-cases`, `mtbs`, `case/:id`, `mtb/:mtbId/case/:id`, case-creation steps) is gated behind a `ProtectedRoute` helper defined in `App.tsx`.
- `src/context/` — `AuthContext`, `CasesContext`, `CaseCreationContext` hold cross-page state. Detail: `docs/AUTH_AND_NOTIFICATIONS.md`, `docs/CASE_AND_MTB_WORKFLOW.md`.
- `src/services/` — `meeting.ts` (meeting orchestration calls out to `jitsi-activation-backend` — though the wired-up "Start Meeting" button actually bypasses it, see `docs/CASE_AND_MTB_WORKFLOW.md`), `whatsappOtp.ts` (Gupshup OTP via Supabase Edge Functions), `voiceTranscriptionService.ts` (see "Do not touch" below).
- `src/Supabase/client.ts` — the single Supabase client instance.
- Backend: Supabase (Auth, Postgres, Storage, Edge Functions, Realtime, RLS). Full table-by-table reference, including which tables actually enforce RLS: `docs/DATABASE_SCHEMA.md`.
- `main/supabase/functions/` and `main/Supabase Edge Functions/` (Deno) — `verify_whatsapp_otp`, `send_whatsapp_otp`, `notify_case_created`, `notify_meeting`, `notify_opinion_added`. Detail: `docs/AUTH_AND_NOTIFICATIONS.md`.
- `main/Cloud Functions/` (AWS Lambda + GCP Cloud Functions, currently git-untracked) — the document-processing backend behind `Reports.tsx`: presigned S3 uploads, PDF→PNG conversion, OCR/anonymization, and AI extraction/summarization of uploaded case documents. This is a separate pipeline from the meeting-transcription one below — don't conflate them. Full detail: `docs/DOCUMENT_AI_PIPELINE.md`.

### Document AI pipeline (`main/Cloud Functions/`)

Turns an uploaded case document into a structured, anonymized, summarized report — presign → PDF→PNG → GCP OCR/anonymize (PaddleOCR + Bedrock, runs in the **old `vmtb` GCP project**) → extract/summarize (Bedrock, LangGraph) → get/delete. Uploaded files and anonymized PDFs live in S3 (`vmtb-bedrock-qwen-bucket-v2`); the AI summary text itself lives in Postgres (`cases.summary`/`ai_generated_summary`), not only in S3.

The summarization step also extracts **patient age and sex** from the documents — via Bedrock native structured outputs, not a prose request — so those are never typed in by the user; they populate `cases.patient_age`/`cases.patient_sex` and are nullable, so every read site must guard them. **`patient_name` is never extracted or written by any Lambda**: it is sensitive PII, it is deliberately absent from the output schema, and that is a hard constraint on any change to this pipeline's prompts or schema. All AWS Lambdas run in `ap-south-1` only. This whole tree (`main/Cloud Functions/`, `main/Supabase Edge Functions/`, `prompts/`) is currently untracked in git — it's live infrastructure, just not yet committed here.

**Owner edits to a case's documents go through pipeline runs** (since 2026-09-17): the Reports page commits a whole batch (redactions, removals, uploads, "Your data") in one Postgres transaction via the `commit_case_edits` RPC, which bumps `cases.content_generation` and records a `case_pipeline_runs` row; the Lambdas then rebuild S3 and the summary from current DB state and may write results only through generation-checked `pipeline_*` RPCs, so a superseded run writes nothing. Don't add pipeline writes that bypass those RPCs, and don't make the UI report "saved" before the RPC returns. MTB members see `cases.verified_snapshot` while newer changes are unverified.

**Full chain, S3 layout, Bedrock models, Phase 3 visual-PII anonymization, and the exact Postgres/S3 storage split: `docs/DOCUMENT_AI_PIPELINE.md`.**

### Notifications

Four Supabase Edge Functions (Deno), all server-side only — the browser never calls Gupshup directly: `send_whatsapp_otp`/`verify_whatsapp_otp` (OTP), `notify_case_created`, `notify_meeting`, `notify_opinion_added`. Full flow detail, including which `AuthContext` methods are legacy/unused: **`docs/AUTH_AND_NOTIFICATIONS.md`.**

### Meeting transcription pipeline

Flow: Jitsi JVB → per-participant Opus audio → `opus-transcriber-proxy` (Opus→PCM16 @16kHz) → `stt-service` (faster-whisper, streaming "committed-prefix" finalization) → final segments written to Supabase → on session close, `meeting.completed` published to Pub/Sub → `transcript-worker` claims the meeting, assembles the ordered transcript, uploads to GCS, generates Minutes-of-Meeting via Mistral, marks `COMPLETED`.

- `meeting_id` in `meeting_transcripts`/`meeting_transcript_segments` is the JVB transcription session id — **not** `meeting_sessions.id` or `mtb_id` (`mtb_id` is NULL in the MVP).
- Schema: `main/supabase/migrations/20260820_meeting_transcripts.sql`.
- `opus-transcriber-proxy` swallows STT/Supabase/Pub-Sub errors by design — transcription failures must never break a live meeting.
- Deployment (Cloud Run/Pub-Sub/GCS) and JVB-side config **are** applied in production for the 4 backend services — see `docs/CLOUD_INVENTORY.md`. The Mumbai GPU-region runbook (`docs/GPU_ACCESS_MUMBAI.md`) has **not** been executed; STT/proxy remain in `asia-southeast1` (Singapore).

**Full data flow, status-machine RPCs, per-service env vars: `docs/MEETING_TRANSCRIPTION_PIPELINE.md`. VM operations/custom domain: `docs/JITSI_VM_OPERATIONS.md`. Prosody/Jicofo wiring: `docs/JITSI_TRANSCRIPTION_CONFIG.md`.**

### Do not touch

The legacy voice-dictation pipeline — `main/src/services/voiceTranscriptionService.ts` and `main/src/components/VoiceRecorder.tsx` — is intentionally kept as-is and is unrelated to the meeting-transcription pipeline above (it's used for dictating case opinions/comments, not meetings). Do not refactor or "consolidate" it with the meeting pipeline. Full catalog of this plus other dead code paths and standing security findings: **`docs/LEGACY_AND_KNOWN_ISSUES.md`.**

## Cloud services matrix

| Provider | Building block | Used for |
|---|---|---|
| Supabase | Postgres + Auth + Storage + Realtime | System of record: users, cases, opinions, treatment plans, meeting sessions/transcripts |
| Supabase | Edge Functions (Deno) | OTP issuance/verification, WhatsApp notifications — anything needing a service-role key |
| AWS | S3 (`vmtb-bedrock-qwen-bucket-v2`) | Document + legacy voice-dictation audio storage, presigned direct-from-browser upload |
| AWS | Lambda (11 functions, `ap-south-1`) | PDF→PNG, OCR/redaction, extraction/summarization orchestration, report list/delete, presign, legacy audio dictation |
| AWS | Bedrock (Qwen3-VL + Qwen3-235B text) | The actual OCR-to-structured-data and summarization model calls |
| GCP (`vmtb-new` project) | Compute Engine | `jitsi-vm` — JVB/Prosody/Jicofo, started/stopped on demand |
| GCP (`vmtb-new` project) | Cloud Run (services, `asia-southeast1`) | `jitsi-activation-backend`, `opus-transcriber-proxy`, `transcript-worker` |
| GCP (`vmtb-new` project) | Cloud Run GPU | `stt-service` (faster-whisper streaming), scale-to-zero |
| GCP (`vmtb-new` project) | Pub/Sub topic `meeting-transcripts` + GCS bucket `vmtb-transcripts` | `meeting.completed` event fan-out; transcript file storage |
| GCP (`vmtb` project — old) | Cloud Run service (`trigger-ocr-service`, `asia-south1`) | Fronts the PaddleOCR job below |
| GCP (`vmtb` project — old) | Cloud Run Job (`paddle-ocr-job`, GPU, `us-east4`) | One-shot PaddleOCR pass per document batch — the anonymization pipeline's OCR step |
| Third-party | Gupshup | WhatsApp Business API for OTP and notifications |
| Third-party | Mistral (`mistral-small-latest`) | Minutes-of-Meeting generation in `transcript-worker` (code is provider-agnostic; confirmed live provider is Mistral) |

## Git Workflow

- Canonical repo: `projecth2025/vMTB-Veritas`. Forks add it as the `upstream` remote; sync with `git fetch upstream && git merge upstream/main`.
- Feature branches off `main`, merged via PR.
- Commit style: `type: short summary`, with a body describing the change.
