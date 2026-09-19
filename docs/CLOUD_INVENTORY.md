# Cloud Inventory

A confirmed, as-queried snapshot of what actually exists in each cloud account this
repo touches, and — critically — **which of it belongs to this project**. The
codebase and this project's cloud accounts are shared with unrelated work
(a pharmacogenomics project called "PGx", a couple of other GCP projects), so
"it's in the account" does not mean "it's part of vMTB Veritas."

This file records ground truth as observed via the AWS/GCP CLIs and the Supabase
Management API on **2026-09-12**, cross-checked against the source in this repo,
with ambiguous items confirmed directly by the project owner. Infrastructure
drifts; re-verify before trusting old entries here for anything change-critical.

## Scope: what's ours vs. not

| Account | In scope for vMTB Veritas | Explicitly out of scope — ignore, don't touch |
|---|---|---|
| Supabase (org `VMTB.in` / `ebcibnvduovoatzjtfzf`) | Project **`vMTB-Veritas`** (`gwvqxetjheveelqrkjhg`) | Project `VMTB-Amala` (`togobilqdevoyijxrexc`) — unrelated project in the same org |
| AWS (account `831516339616`) | Everything named/prefixed `VMTB`/`vmtb`, region **`ap-south-1` only** | Everything prefixed `pgx-` (Lambdas, S3 buckets `pgx-bucket-v1`/`pgx-testing-bucket`, API Gateway `PGx-APIs`, ECR `pgx-rm2results`/`pgx-gatk-calling`) — a separate pharmacogenomics project sharing this AWS account. **Also out of scope: everything in `us-east-1`** — confirmed dead, see below. |
| GCP | Two projects, both in scope but for **different halves of the system** — see next section | Projects `lab-hyd`, `pgx-engine-498217` (PGx's GCP counterpart), `vmtb-iitj` — visible under the same Google account but not part of this repo |

## GCP: two projects, mid-migration — the single most important thing to know here

The team is migrating off an older GCP project onto a new one. **The migration is
partial and intentionally so** — don't assume everything moved:

| | `vmtb` (old) | `vmtb-new` (current) |
|---|---|---|
| Project ID | `project-d62706c7-1f50-4a3c-870` | `vmtb-new` |
| Project number | `622331214924` | `670475652201` |
| Hosts today | **Document AI / anonymization pipeline** (PaddleOCR job + its trigger service) + a terminated old meeting VM | **Live meeting + transcription pipeline** (activation backend, Jitsi VM, opus proxy, STT, transcript worker) |
| Status | Still actively used for anonymization — **not** legacy as a whole, only specific resources in it are | Current/live for everything meeting-related |

Confirmed live resources, by project (`gcloud compute instances list` / `gcloud run services list` / `gcloud run jobs list` / `gcloud pubsub topics list` / `gcloud storage buckets list`, run against each project directly):

**`vmtb` (old project) — anonymization pipeline lives here:**
- `paddle-ocr-job` — Cloud Run **Job** (`us-east4`), last run 2026-09-05 — this is the real one; matches `JOB_NAME` in `Trigger-GCP-jobs`/`GCP-Jobs`.
- `trigger-ocr-service` — Cloud Run service (`asia-south1`) — the FastAPI trigger in front of the job; matches the `ANONYMIZE_LAMBDA_API` URL hardcoded in `ConvertPdf2Png`.
- `paddleocr-gpu-service` — Cloud Run service (`us-east4`) — **confirmed leftover, not used.** An earlier attempt at running PaddleOCR as a persistent service before the Cloud Run Job pattern replaced it. Safe to treat as dead; candidate for deletion, but not deleted here without an explicit ask.
- `jitsi-vm` (Compute Engine, `asia-south1-c`, `e2-standard-4`) — **the old meeting VM.** Currently `TERMINATED`. This is not the VM the live meeting pipeline uses anymore (see `vmtb-new` below) — don't confuse the two when working on meetings.
- No Pub/Sub topics, no transcript-related storage buckets in this project — confirms the transcription pipeline does not run here.

**`vmtb-new` (current project) — meeting + transcription pipeline lives here:**
- `jitsi-vm` (Compute Engine, `asia-south1-c`, `e2-medium` — smaller than the old VM's `e2-standard-4`, reflecting the cost-tuning work in this repo's git history). Currently `TERMINATED` (scale-to-zero when no meeting is active — expected).
- `jitsi-activation-backend` — Cloud Run service, **`asia-southeast1`**. **This is the live one — supersedes the Render deployment described elsewhere in this repo's docs.** Confirmed directly: Render is no longer current. (Deployed by a personal `@iitj.ac.in` account rather than the `vmtb-deployer` service account used for the other three — worth moving to the standard deploy account/CI path at some point, but functionally it's the live one today.)
- `opus-transcriber-proxy`, `stt-service`, `transcript-worker` — all Cloud Run services, **`asia-southeast1`**, all deployed via `vmtb-deployer@vmtb-new.iam.gserviceaccount.com`.
- Pub/Sub topic: `meeting-transcripts` (note the actual name — code/docs elsewhere refer to the `meeting.completed` *event*, which is published to this topic).
- GCS bucket: `vmtb-transcripts` (`asia-southeast1`) — where `transcript-worker` uploads `transcript-v{n}.{json,txt}`.

**Practical implication:** if you're working on the document/anonymization pipeline, your `gcloud` context is the **old `vmtb` project**. If you're working on meetings/transcription, it's **`vmtb-new`**. Don't assume a resource exists in the project you happen to be looking at — check.

## AWS: one account, two unrelated projects, one dead region

Account `831516339616`. Confirmed via `aws lambda list-functions`, `aws ecr describe-repositories`, `aws s3api list-buckets`, `aws apigatewayv2 get-apis/get-routes/get-integrations` across all regions.

### Region rule

**Only `ap-south-1` (Mumbai) is live and in use.** Everything found in `us-east-1` is confirmed dead — made early in the project and no longer needed:

- Lambda `VMTB-BEDROCK-DOCKER-US-V1` (`us-east-1`) — **State: `Inactive`**. An early, monolithic predecessor to today's split pipeline (its LangSmith project name is `VMTB-AWS-BEDROCK-V1`). Backed by ECR repo `api2-process-documents` (31 images, mostly untagged — build history for a dead Lambda).
  - ⚠️ **Security note, unrelated to its dead/alive status:** this Lambda's environment variables contain a plaintext `LANGCHAIN_API_KEY` (LangSmith API key). Since it's confirmed dead, the cleanest fix is deleting the function outright (removes the exposed secret with it) rather than just leaving it inactive — flagging for you to decide, not doing it unprompted.
- ECR repo `api2-process-documents` (`us-east-1`) — dead, per above.

Confirmed via the project owner: **treat all `us-east-1` resources as out of scope / safe to eventually decommission.**

### `ap-south-1` — live resources (14 Lambdas: the original 11, matching this repo's `main/Cloud Functions/AWS/*` folders, plus 3 added 2026-09-14 for the manual anonymization editor)

| AWS Lambda function name | Repo folder | Type | Notes |
|---|---|---|---|
| `VMTB-S3-Presigned-URLS-V2` | `VMTB-S3-Presigned-URLS-V2` | Zip | |
| `VMTB-S3-PRESIGNED-URLS_4_UPLOAD_NEW_DOCUMENTS_V2` | (same name) | Zip | |
| `VMTB-CONVERT-DOC2PNG-V2` | `ConvertPdf2Png` | Image (ECR `convert-doc2png-v2`) | Repo folder name and deployed function name differ — don't search for "convert-doc2png" as a Lambda name, it's `VMTB-CONVERT-DOC2PNG-V2`. Live tag `pipeline-runs-20260917` (2026-09-17): within a pipeline run it converts only that run's `upload_files` and skips `.txt`. Rollback: tag `latest`. |
| `VMTB-OCR2ANO-V2` | `VMTB-OCR2ANO-V2` | Image (ECR `ocr2ano`) | The text-PII redaction Lambda (see Phase 3 anonymization notes elsewhere). As of 2026-09-14 also retains unredacted page originals in S3 and persists redaction metadata for the manual anonymization editor — see `docs/DOCUMENT_AI_PIPELINE.md`. Live tag `pipeline-runs-20260917c` (2026-09-17: skips documents removed in Postgres, generation-stamped versions, reports completion via `pipeline_finish_anonymize` — see "Edits and pipeline runs" in `docs/DOCUMENT_AI_PIPELINE.md`). Rollback: tag `report-status-cleanup` (previous live); `pre-manual-redaction-editor` is the older pre-editor point. |
| `VMTB-EXTRACT-SUMMARIZE-V2` | `VMTB-EXTRACT-SUMMARIZE-V2` | Image (ECR `extract-summarize-v2`) | As of 2026-09-17 runs tag `pipeline-runs-20260917b` (pipeline-run aware: reads the document set, removed names, "Your data" and live `.txt` documents from Postgres; writes the summary only through the generation-checked `pipeline_write_summary` RPC; failures go to `pipeline_fail`). Builds on `structured-age-sex` (2026-09-16, patient age/sex via Bedrock structured outputs — see `docs/DOCUMENT_AI_PIPELINE.md`). Rollback: tag `structured-age-sex` (`sha256:2f8eeb6905fdb4cd75911fab923cd1c1d5dcd4aa8ad0a23ded5853f3729a5ad5`); note the frontend's pipeline-run flow depends on the new image. |
| `VMTB-GET-REPORTS` | `VMTB-GET-REPORTS` | Zip | Redeployed 2026-09-17: lists only direct children of `data/`, optional `filename` (re-sign one) and `version_keys` (sign archived versions, restricted to `data/`/`versions/`) params — see `docs/DOCUMENT_AI_PIPELINE.md`. |
| `VMTB-DELETE-OBJECT` | `VMTB-DELETE-OBJECT` | Zip | No longer called by the Reports page (removals are committed edits since 2026-09-17); route still live. |
| `VMTB-presignedURLs-audio` | `VMTB-presignedURLs-audio` | Zip | Legacy voice-dictation pipeline — do not touch (see main `CLAUDE.md`) |
| `VMTB-Transcribe-Audio` | `VMTB-Transcribe-Audio` | Zip | Legacy voice-dictation pipeline — do not touch |
| `VMTB-Trigger-transcribe-audio-lambda-function` | `VMTB-Trigger-transcribe-audio-lambda-function` | Zip | Legacy voice-dictation pipeline — do not touch |
| `200-OK-V2` | `200-OK-V2` | Zip | See "fire-and-forget" pattern below — this is load-bearing, not a placeholder. Since 2026-09-17 also forwards `run_id`/`upload_files`. |
| `VMTB-APPLY-REDACTION-CHANGES-V2` | `VMTB-APPLY-REDACTION-CHANGES-V2` | Image (ECR `apply-redaction-changes`) | Added 2026-09-14; since 2026-09-17 (live tag `pipeline-runs-20260917b`, rollback `resummarize-fix`) it is the pipeline-run **materializer**: invoked with `{run_id}`, it makes S3 match the edits already committed in Postgres (renames removed documents, re-renders documents whose regions changed), then hands off to the converter or `/extract`. Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `EXTRACT_API_URL`. Async-invoke retries set to **0** (a retry would only repeat a failure the run already recorded). Reuses `VMTB-OCR2ANO-V2`'s execution role (same S3 bucket access) rather than a dedicated one — a deliberate least-effort choice for a single-account project with no real users of this feature yet, see `docs/LEGACY_AND_KNOWN_ISSUES.md`. |
| `VMTB-TRIGGER-APPLY-REDACTION-CHANGES-V2` | `VMTB-TRIGGER-APPLY-REDACTION-CHANGES-V2` | Zip | Added 2026-09-14. Since 2026-09-17 it async-invokes the above directly (`lambda.invoke`, `InvocationType='Event'`, function from `TARGET_FUNCTION_NAME`, default `VMTB-APPLY-REDACTION-CHANGES-V2`) with `{run_id}` and returns 202 — no longer an HTTP fire-and-forget. Reuses `200-OK-V2`'s execution role, which now has an inline policy `trigger-apply-redaction-changes-invoke` (`lambda:InvokeFunction` on the Apply function only). A leftover `TARGET_API_URL` env var is no longer read. |
| `VMTB-GET-ORIGINALS-V2` | `VMTB-GET-ORIGINALS-V2` | Zip | Added 2026-09-14. Presigns URLs for the retained unredacted originals, for the redaction editor UI only. Reuses `VMTB-GET-REPORTS`'s execution role. |

ECR repos in `ap-south-1`: `convert-doc2png-v2`, `extract-summarize-v2`, `ocr2ano` (all VMTB, all in active use — `ocr2ano` alone has 12+ image versions, mostly untagged build history; `latest` and `manual-redaction-editor` are the current live tag as of 2026-09-14, `pre-manual-redaction-editor` is the rollback point; `extract-summarize-v2`'s live tag is `structured-age-sex` as of 2026-09-16, with `originals-fallback` as its rollback point), `apply-redaction-changes` (added 2026-09-14; all four repos gained `pipeline-runs-20260917*` tags on 2026-09-17, see the table) — plus `pgx-rm2results`/`pgx-gatk-calling` (PGx, ignore).

S3: `vmtb-bedrock-qwen-bucket-v2` (VMTB, in use) plus `pgx-bucket-v1`/`pgx-testing-bucket` (PGx, ignore). As of 2026-09-14 this bucket has one Lifecycle Rule (`expire-manual-redaction-originals-30d`): objects tagged `ManualRedactionOriginal=true` expire after 30 days. Tag-based, not prefix-based — `uploads/{request_id}/originals/` has a different `request_id` per upload, so no single literal prefix matches all of them (S3 Lifecycle Rules don't support wildcards).

API Gateway (HTTP API, id `gzgrswe52e`, `VMTB-BEDROCK-QWEN-API-V2`, stage `dev` — **`AutoDeploy` is off for this stage**, a new route needs an explicit `create-deployment` + `update-stage` or it silently never goes live) — routes and what they actually hit, confirmed via `get-routes`/`get-integrations` (not assumed from code):

| Route | → Lambda | Status |
|---|---|---|
| `POST /get-upload-urls` | `VMTB-S3-Presigned-URLS-V2` | live |
| `POST /get-upload-urls_4_new_documents` | `VMTB-S3-PRESIGNED-URLS_4_UPLOAD_NEW_DOCUMENTS_V2` | live |
| `POST /trigger-converter-files-to-png` | `200-OK-V2` | live — **intentional**, see below |
| `POST /converter-files-to-png` | `VMTB-CONVERT-DOC2PNG-V2` | live (called by `200-OK-V2`, not directly by the frontend) |
| `POST /extract` | `VMTB-EXTRACT-SUMMARIZE-V2` | live |
| `POST /ocr2ano` | `VMTB-OCR2ANO-V2` | live (called from GCP's `paddle-ocr-job`) |
| `GET /get-reports` | `VMTB-GET-REPORTS` | live |
| `POST /delete-reports` | `VMTB-DELETE-OBJECT` | live |
| `POST /get-presignedURLs-audio` | `VMTB-presignedURLs-audio` | live |
| `POST /transcribe-audio` | `VMTB-Trigger-transcribe-audio-lambda-function` | live |
| `POST /anonymize` | `VMTB-CALL-ECS4ANO-V2` | **dead** — target Lambda deleted. Confirmed legacy (pre-dates the GCP PaddleOCR job; this was an older ECS-based anonymizer). Matches the commented-out `ANONYMIZE_API` line still sitting in `VMTB-EXTRACT-SUMMARIZE-V2`'s source. |
| `POST /test-pp-ocr` | `TEST-LAMBDA-OCRv5` | **dead** — target Lambda deleted, confirmed early-stage test artifact |
| `POST /apply-redaction-changes` | `VMTB-APPLY-REDACTION-CHANGES-V2` | live, added 2026-09-14 — internal only; since 2026-09-17 the trigger invokes the function directly, so nothing in this repo calls this route |
| `POST /trigger-apply-redaction-changes` | `VMTB-TRIGGER-APPLY-REDACTION-CHANGES-V2` | live, added 2026-09-14 — called by the frontend (`pipelineService.startRun`) with a `run_id` after every committed edit/regenerate/retry |
| `GET /get-originals` | `VMTB-GET-ORIGINALS-V2` | live, added 2026-09-14 — called by the frontend redaction editor |

Also present but **orphaned** (integrations with no route attached, pointing at functions that no longer exist — `VMTB-Audio-Transcribe`, `TEST-PP-OCRv5`, `ocr-demo` — plus one, `VMTB-Transcribe-Audio`, whose function *does* still exist but isn't reachable through this dangling integration since the real `/transcribe-audio` route uses a different integration). Harmless clutter, not wired to anything reachable; no action needed unless you're doing a general API Gateway cleanup.

### `vmtb-bedrock-qwen-bucket-v2` — full bucket layout (explored directly, 2026-09-12)

This bucket is **not document-pipeline-only** — it's shared across both AWS pipelines. 2,112 objects, ~1.47 GB total, four top-level prefixes:

| Prefix | Contents |
|---|---|
| `uploads/` | Per-request working data — `uploads/{request_id}/data/` (originals + page PNGs + anonymized PDFs) and `uploads/{request_id}/results/` (`ocr_full.json`, `intermediate_step.json`, `final_summary.json`, `error.json`). 160+ request-id folders present. |
| `prompts/` | Exactly 3 files, all mirrored in this repo's local `prompts/` dir: `ocr_prompt.txt` (extraction), `summary_prompt.txt` (summarization), `transcription_prompt.txt` (a chunk-merging prompt — used by the legacy voice-dictation pipeline's transcription, unrelated to document processing; do not confuse with `stt-service`'s own transcription, which is a completely separate meeting pipeline in GCP). Loaded at Lambda cold-start by `VMTB-EXTRACT-SUMMARIZE-V2`; as of the Phase 3 visual-anonymization work, also by `VMTB-OCR2ANO-V2` (`visual_pii_prompt.txt`, added then). |
| `recordings/` | Legacy voice-dictation audio recordings, per-recording-id folders — confirms this bucket also backs `voiceTranscriptionService.ts` / `VMTB-presignedURLs-audio` / `VMTB-Transcribe-Audio`, not only the document pipeline. |
| `codes/` | A single leftover file, `codes/lambda.zip` — an old deployment artifact, unclear which Lambda it belongs to. Not touched; flagged only for completeness. |

**Correction to a natural assumption**: at the time of the Phase 3 investigation, there was no pre-existing visual-PII or anonymization-specific prompt sitting in this bucket — only the 3 files above. What already existed was the *convention* (a `prompts/*.txt` file per task, loaded from S3 at cold-start, with a tracked local copy in this repo), not a ready-made prompt for every future task.

### The `200-OK-V2` fire-and-forget pattern — why it exists (load-bearing, confirmed by the project owner)

API Gateway enforces a hard ~30s integration timeout. The real document pipeline
(`VMTB-CONVERT-DOC2PNG-V2` → OCR → anonymize → extract/summarize) routinely runs
well past that. Calling the real converter directly from the frontend caused
API Gateway to time out and return an error to the browser even though the
Lambda kept running successfully in the background.

The fix: `200-OK-V2` (`main/Cloud Functions/AWS/200-OK-V2/lambda_function.py`)
sits in front of `VMTB-CONVERT-DOC2PNG-V2`. It fires a POST at `TARGET_API_URL`
(the real `/converter-files-to-png` route) with a 5-second socket timeout,
**deliberately ignores the response or any error from it**, and always returns
`200 OK` immediately. The frontend (`ReviewCase.tsx`, `Reports.tsx`) calls
`/trigger-converter-files-to-png` — i.e., it always goes through this wrapper,
never the real converter route directly. This is intentional infrastructure,
not dead code or a stub to be "fixed."

## Supabase

Org `VMTB.in` (`ebcibnvduovoatzjtfzf`, free plan). Two projects exist; only one is this repo:

- **`vMTB-Veritas`** (`gwvqxetjheveelqrkjhg`, `ap-south-1`) — this repo's backend. Confirmed by direct table inspection: schema matches `main/supabase/migrations/`.
- `VMTB-Amala` (`togobilqdevoyijxrexc`, `ap-south-1`) — a separate project in the same org, unrelated to this repo. Don't query or modify it as part of vMTB Veritas work.

⚠️ Separate, standing finding from the table inspection of `vMTB-Veritas` (not new to this document, but worth repeating here): **14 tables have Row Level Security disabled**, including `cases`, `case_documents`, `case_opinions`, `case_treatment_plans`, `mtbs`, `mtb_members`, `meeting_sessions`, `meeting_participants` — fully readable/writable by anyone holding the anon key. Not fixed here; needs an explicit decision plus policy design before enabling.
