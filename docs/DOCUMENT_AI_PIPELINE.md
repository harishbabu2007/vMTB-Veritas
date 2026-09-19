# Document AI Pipeline (case document upload → anonymization → AI summary)

Turns an uploaded case document into a structured, anonymized, AI-summarized
report. All of it lives in AWS plus one GCP job; the browser only ever talks
to S3 (presigned upload) and Supabase (status polling) directly, never to any
Lambda directly except through the trigger wrapper described in step 0.

This pipeline is entirely separate from the meeting-transcription pipeline
(`docs/MEETING_TRANSCRIPTION_PIPELINE.md`) — don't conflate them. It's also
distinct from the **legacy voice-dictation pipeline** (do not touch — see
`docs/LEGACY_AND_KNOWN_ISSUES.md`), which uses the same S3 bucket for a
completely different purpose.

**Source location:** `main/Cloud Functions/` (AWS Lambdas + one GCP Cloud
Run job/service), `main/Supabase Edge Functions/`, and `prompts/` — all
currently **git-untracked** despite being live infrastructure (per the root
`CLAUDE.md`).

## The chain, in order

0. **Trigger wrapper (`200-OK-V2`).** The frontend never calls the real
   converter directly. `ReviewCase.tsx` POSTs to
   `/trigger-converter-files-to-png`, which routes to `200-OK-V2`
   (`main/Cloud Functions/AWS/200-OK-V2/lambda_function.py`). This fires the
   actual request at `VMTB-CONVERT-DOC2PNG-V2` with a 5s socket timeout,
   **deliberately ignores the response or any error from it**, and always
   returns `200 OK` immediately.

   **Why this exists (load-bearing, not a stub):** API Gateway enforces a
   hard ~30s integration timeout. The real pipeline (convert → OCR →
   anonymize → extract/summarize) routinely runs well past that. Calling the
   real converter directly from the browser caused API Gateway to time out
   and show the user an error even though the Lambda kept running
   successfully in the background. `200-OK-V2` exists purely to give the
   browser an immediate `200` while the real work continues async.

1. **Presign.** `VMTB-S3-Presigned-URLS-V2` /
   `VMTB-S3-PRESIGNED-URLS_4_UPLOAD_NEW_DOCUMENTS_V2` issue short-lived S3
   `PUT`/POST-form credentials plus a `request_id`. The browser
   (`ReviewCase.tsx`) uploads each pending file straight to S3 using those
   credentials — no Lambda sees the file bytes at upload time.

2. **PDF → PNG.** `ConvertPdf2Png` (deployed as `VMTB-CONVERT-DOC2PNG-V2`;
   PyMuPDF) renders each uploaded page to PNG, then calls onward to the GCP
   OCR trigger and the extraction Lambda.

3. **OCR + anonymize.** `Trigger-GCP-jobs` (Cloud Run service,
   `main/Cloud Functions/GCP/`, deployed as `trigger-ocr-service` in the
   **old `vmtb` GCP project** — see `docs/CLOUD_INVENTORY.md`) launches
   `GCP-Jobs` (deployed as `paddle-ocr-job`), a Cloud Run **Job** — runs to
   completion, not a long-lived service, region `us-east4` — that runs
   PaddleOCR on GPU to locate text/PII regions and writes OCR output to
   `uploads/{request_id}/results/ocr_full.json`.

   `VMTB-OCR2ANO-V2` then:
   - draws white-box redactions over detected PII regions,
   - as of the Phase 3 visual-anonymization work (see below), also detects
     and redacts **visual/non-text** PII via a concurrent Bedrock vision
     call,
   - calls Bedrock (`qwen.qwen3-235b-a22b-2507-v1:0`) for text processing,
   - writes anonymized PDFs back to `uploads/{request_id}/data/`,
   - and, when its pass finishes, calls the `pipeline_finish_anonymize` RPC
     (`20260918_pipeline_finish_anonymize.sql`), scoped by `request_id`: it
     completes (or fails, see "Edits and pipeline runs") the anonymize step of
     every waiting upload run and sets `cases.report_status = 'verified'` once
     no upload run is still waiting — **this is the anonymization-done signal,
     not the summary-done signal** (see "Where things are stored" below). Since
     2026-09-17 it does this through `pipeline_finish_anonymize`, which also
     marks the run's anonymize step done — or fails the run
     (`ANONYMIZE_INCOMPLETE`) if one of the run's own uploads wasn't
     published. See "Edits and pipeline runs" below.

   This whole step runs in the **old `vmtb` GCP project**, not `vmtb-new`
   (which hosts the unrelated meeting/transcription pipeline) — see
   `docs/CLOUD_INVENTORY.md`.

4. **Extract + summarize.** `VMTB-EXTRACT-SUMMARIZE-V2` runs a LangGraph
   state machine (traced via LangSmith) over Bedrock's Qwen3-VL
   (OCR/extraction) and Qwen3-235B (summarization), batching pages and
   tracking token cost. Since 2026-09-16 the summarization call uses
   **Bedrock native structured outputs** (Converse `outputConfig.textFormat`,
   type `json_schema`), so the model returns `{summary, patient_age,
   patient_sex}` as schema-constrained JSON instead of free text. Writes:
   - `uploads/{request_id}/results/intermediate_step.json` (S3, intermediate
     OCR text),
   - `uploads/{request_id}/results/final_summary.json` (S3, `{final_summary,
     patient_age, patient_sex, metadata}`),
   - `uploads/{request_id}/results/error.json` (S3, on failure),
   - **and** `cases.summary` + `cases.ai_generated_summary` (same text,
     duplicated into both columns) + `cases.summary_status = 'unverified'`
     in Supabase, via its `update_case_summary()` helper — plus
     `cases.patient_age` / `cases.patient_sex`, which are written **only when
     extraction actually produced a value**, so a null never overwrites a
     value a user entered by hand.

   If the structured call fails twice, it falls back to a single
   unstructured call: the summary text is still saved and age/sex are left
   null, rather than losing the summary as well. `patient_name` is never
   requested or written by this Lambda under any code path — it is not in the
   output schema, and no code path writes that column. It is highly sensitive
   PII; keep it out of both when changing this step.

   The **summary prose deliberately does not restate age or sex**. They are
   returned in the two structured fields and rendered once in the case-details
   row of the summary page, so repeating them in the body is redundant — the
   S3 prompt forbids it in the summary text while still requiring both
   separate fields. How these surface in the app:
   `docs/CASE_AND_MTB_WORKFLOW.md`.

   **Where it reads pages from** (`document_listing.plan_documents`): a
   document is *live* if it is a finished `ANO_NNCMFAGSSS_22246_{name}.pdf`
   directly under `data/` or a `data/{folder}/` still holding `page_N.png`
   files (soft-deleted `DELETE_` files and names removed in Postgres are
   excluded). Its pages come from `data/{folder}/` while it is still being
   processed, otherwise from the retained unredacted
   `uploads/{request_id}/originals/{name}/page_N.png`. Once
   `VMTB-OCR2ANO-V2` has built a document's PDF it deletes that
   `data/{folder}/` page folder, so **re-summarizing a finished document
   depends on its originals still existing** (30-day retention, see "Manual
   anonymization editor"); a live document with no pages in either place
   contributes nothing. If the run finds no page images and no notes/text at
   all, the summary text is the literal string `no data` — that is what a
   summary showing "no data" means.

   **Prompts are loaded from S3 at cold-start**
   (`prompts/ocr_prompt.txt`, `prompts/summary_prompt.txt` under
   `PROMPT_PREFIX`, plus `prompts/visual_pii_prompt.txt` for the Phase 3
   work below) — editing those files in this repo's `prompts/` directory and
   re-uploading to S3 is how you change model behavior here, no redeploy
   needed. One exception: the JSON field definitions for `patient_age` /
   `patient_sex` (`SUMMARY_OUTPUT_INSTRUCTIONS`) live in the Lambda source,
   not in the S3 prompt, so the shared prompt file stays correct for any
   image that predates structured outputs.

   Since 2026-09-17, a run started by a case edit writes the summary only
   through the generation-checked `pipeline_write_summary` RPC, so a run
   superseded by a newer save writes nothing (see "Edits and pipeline runs").

5. **Read/delete.** `VMTB-GET-REPORTS` backs the list in `Reports.tsx`
   (see below — it reads S3 `data/`, never `results/`). Removing a document
   is a committed edit applied by `VMTB-APPLY-REDACTION-CHANGES-V2`, not a
   direct `VMTB-DELETE-OBJECT` call (see "Edits and pipeline runs").

## Where uploaded files and generated summaries actually live

This is the question a newcomer usually has first, so it's answered
explicitly here rather than only implicitly in the chain above:

- **Binary files** (originals, page PNGs, anonymized PDFs) — **S3 only**,
  bucket `vmtb-bedrock-qwen-bucket-v2`, under
  `uploads/{request_id}/data/`. Postgres never holds file bytes, only
  pointers.
- **The AI-generated summary text itself** — lives in **Postgres**,
  `cases.summary` and `cases.ai_generated_summary` (duplicated into both
  columns by `VMTB-EXTRACT-SUMMARIZE-V2`), **not** only in the S3
  `results/final_summary.json` file (that file also exists, but the app
  reads the summary from Postgres, not from S3).
- **Per-file metadata** (name, size, type, S3 key) — Postgres,
  `case_documents.storage_path`.
- **The user-typed "case explanation"** — Postgres,
  `case_additional_documents.document_data`, plain text, not S3-backed at
  all.
- Full column reference: `docs/DATABASE_SCHEMA.md`.

### Two independently-driven status columns — easy to conflate

- **`cases.report_status`** (`not_ready → verified`) — a plain "are the
  anonymized files ready" flag. Set to `not_ready` when a run that includes
  uploads starts (`commit_case_edits`, `start_initial_run`, `retry_case_run`)
  and to `verified` by `pipeline_finish_anonymize` (called by
  `VMTB-OCR2ANO-V2`) once no upload run is still waiting to be anonymized.
  **Reports have no owner verification step** — only the AI summary is
  verified. `unverified` is still in the frontend `ReportStatus` type
  (`CasesContext.tsx`) but no migration, Lambda or UI path writes it any more,
  and the owner-facing "Verify Report" action was removed. `Reports.tsx`
  shows a blocking "still anonymizing" placeholder only while `not_ready`
  **and** no document has loaded yet; once documents have loaded they stay
  visible during a reprocess, with a small "Reprocessing documents…" badge.
- **`cases.summary_status`** (`processing → unverified → verified/failed`) —
  set to `unverified` by `VMTB-EXTRACT-SUMMARIZE-V2` once the AI summary is
  ready; set to `verified` by a separate "verify summary" action, which is
  itself blocked until `patient_age`/`patient_sex` are present. This value
  **cycles** — every regeneration sends it back to `processing`, so it does
  *not* govern tab locking; `cases.first_verified_at` (set once, never
  cleared) does. See `docs/CASE_AND_MTB_WORKFLOW.md`.

These two pipelines (anonymize vs. summarize) run concurrently off the same
`request_id` and complete independently — a case can show anonymized
documents (`report_status='verified'`) well before its AI summary is ready
(`summary_status` still `'processing'`), or vice versa.

## How the frontend reads it back

- **Summary text** — read straight from Supabase (`cases.summary` /
  `ai_generated_summary`) via `CasesContext`, rendered in `ViewCase.tsx`.
- **Document files** (to view/download) — the frontend calls the
  `VMTB-GET-REPORTS` Lambda (`GET /get-reports?request_id=...`), which lists
  only the **direct children** of `uploads/{request_id}/data/` (`Delimiter='/'`
  — per-page working folders like `data/{doc}/page_0.png` are never listed),
  skips anything renamed with the `DELETE_NNCMFAGSSS_22246_` prefix, and
  returns short-lived (15 min, `expires_in`) presigned GET URLs. Optional
  params: `filename` re-signs one document right before it is opened (so a
  stale list never hands the viewer an expired URL); `version_keys`
  (comma-separated) signs specific archived versions for the MTB-member
  snapshot view, and only keys under this request's `data/` or `versions/`
  with no `..` — never `originals/` or `results/`.
- The Reports list is additionally filtered by Postgres: a document whose
  `case_documents` row is deleted (and has no live row under the same name)
  is hidden even if its file is still in S3.
- **Deletes** are no longer a direct S3 call from the Reports page: they are
  part of a committed edit (see "Edits and pipeline runs" below), and the
  materializer Lambda soft-deletes the file (same `DELETE_NNCMFAGSSS_22246_`
  rename). `VMTB-DELETE-OBJECT` (`POST /delete-reports`) still exists but the
  Reports page no longer uses it.

## S3 bucket layout (`vmtb-bedrock-qwen-bucket-v2`)

Shared across both this pipeline **and** the legacy voice-dictation
pipeline — not document-pipeline-only. ~2,100 objects, four top-level
prefixes:

| Prefix | Contents |
|---|---|
| `uploads/` | Per-request working data: `uploads/{request_id}/data/` (originals, page PNGs, anonymized PDFs) and `uploads/{request_id}/results/` (`ocr_full.json`, `intermediate_step.json`, `final_summary.json`, `error.json`) |
| `prompts/` | `ocr_prompt.txt`, `summary_prompt.txt`, `visual_pii_prompt.txt` (Phase 3), `transcription_prompt.txt` (legacy voice-dictation chunk-merging prompt — **not** related to `stt-service`'s meeting transcription) — all mirrored in this repo's local `prompts/` dir and loaded at Lambda cold-start |
| `recordings/` | Legacy voice-dictation audio recordings, per-recording-id folders |
| `codes/` | One leftover file, `codes/lambda.zip` — an old deployment artifact, unclear which Lambda it belongs to; not touched |

## Bedrock models in use

- `qwen.qwen3-235b-a22b-2507-v1:0` — text PII classification/redaction
  decisions (`VMTB-OCR2ANO-V2`) and summarization (`VMTB-EXTRACT-SUMMARIZE-V2`).
- `qwen.qwen3-vl-235b-a22b` — vision-capable model used for OCR/extraction
  (`VMTB-EXTRACT-SUMMARIZE-V2`) and, since Phase 3, visual-PII detection
  (`VMTB-OCR2ANO-V2`).

## Phase 3: visual/non-text PII detection

Extends `VMTB-OCR2ANO-V2`'s original text-only redaction (PaddleOCR only
extracts printed text, so a logo, signature, stamp, or QR code was invisible
to the pipeline before this) with a second, **concurrent** Bedrock vision
call per page:

1. `process_single_page_with_anonymization` runs the existing text-PII call
   (`call_llm`) and the new `call_vision_pii_detector` concurrently via a
   `ThreadPoolExecutor`. Neither draws on the image until both resolve.
2. `call_vision_pii_detector` resizes a **copy** of the page image (never
   the original) to `VISION_MAX_LONG_EDGE` px, JPEG-encodes it, and sends it
   to Bedrock with the prompt from `prompts/visual_pii_prompt.txt`, asking
   for a JSON array of `{category, confidence, bbox_normalized}`.
3. `parse_and_validate_visual_json` parses/repairs the response (reusing the
   existing `fix_json_string` helper) and drops unrecognized categories or
   malformed fields.
4. Detections with `confidence >= VISUAL_PII_CONFIDENCE_THRESHOLD` (`0.7` —
   deliberately strict, precision over recall) have their normalized bbox
   converted to pixel coordinates **against the original, full-resolution
   image** (decoupled from whatever size was sent to the model, so resizing
   never shifts redaction placement). Below-threshold detections are logged
   but never redacted.
5. Drawn with the same `ImageDraw.rectangle(bbox, fill="white")` primitive
   already used for text PII — solid opaque white, never blur.

Constants (top of `lambda_function.py`, tunable without touching the
prompt): `VISION_MODEL_ID`, `VISUAL_PII_CONFIDENCE_THRESHOLD = 0.7`,
`VISION_MAX_LONG_EDGE = 1600`, `VISION_JPEG_QUALITY = 90`,
`VISUAL_PII_CATEGORIES`.

**Known unknowns, not yet resolved as of this writing:**
- `VISION_MAX_LONG_EDGE`/`VISION_JPEG_QUALITY` are reasoned starting points
  (larger than the sibling extraction Lambda's 800px/quality-85 thumbnail,
  to keep small QR codes/stamps/signatures legible) but **not empirically
  validated** against real hospital documents — no real samples were
  available when this was built.
- Cost/latency: one extra Bedrock vision call per page, run concurrently
  with the existing text call (added latency ≈ `max(text_call,
  vision_call)`, not their sum).
- Already-anonymized documents are **not** retroactively re-scanned for
  visual PII — this is additive, not a backfill. A document anonymized
  before this shipped needs re-upload to benefit.
- No automated tests existed for this Lambda before Phase 3. Two new,
  local-only files were added (not shipped in the deployed image — the
  Dockerfile only `COPY`s `requirements.txt` and `lambda_function.py`):
  `test_visual_pii.py` (pytest unit tests for the pure coordinate/JSON-repair
  logic, no AWS calls) and `manual_validate_visual_redaction.py` (a
  standalone synthetic-image validation script, proves the coordinate math
  end-to-end but not real-world detection accuracy).
- The Lambda's response gains one additive key,
  `total_visual_pii_found`, alongside the existing `total_pii_found`
  (text-only meaning unchanged) — nothing in this repo currently parses this
  Lambda's response body, so zero regression risk.

## AWS Lambda + API Gateway reference

All 11 Lambdas run in **`ap-south-1` only**, behind one API Gateway
(`gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/...`,
`VMTB-BEDROCK-QWEN-API-V2`). A `us-east-1` Lambda
(`VMTB-BEDROCK-DOCKER-US-V1`) and its routes are confirmed dead/legacy — see
`docs/CLOUD_INVENTORY.md` for the full region rule and a flagged plaintext
LangSmith key on that dead Lambda.

| Route | → Lambda | Status |
|---|---|---|
| `POST /get-upload-urls` | `VMTB-S3-Presigned-URLS-V2` | live |
| `POST /get-upload-urls_4_new_documents` | `VMTB-S3-PRESIGNED-URLS_4_UPLOAD_NEW_DOCUMENTS_V2` | live |
| `POST /trigger-converter-files-to-png` | `200-OK-V2` | live — intentional wrapper, see step 0 |
| `POST /converter-files-to-png` | `VMTB-CONVERT-DOC2PNG-V2` | live (called by `200-OK-V2`, not directly by the frontend) |
| `POST /extract` | `VMTB-EXTRACT-SUMMARIZE-V2` | live |
| `POST /ocr2ano` | `VMTB-OCR2ANO-V2` | live (called from GCP's `paddle-ocr-job`) |
| `GET /get-reports` | `VMTB-GET-REPORTS` | live |
| `POST /delete-reports` | `VMTB-DELETE-OBJECT` | live (no longer called by the Reports page) |
| `POST /anonymize` | `VMTB-CALL-ECS4ANO-V2` | **dead** — target Lambda deleted (pre-dates the GCP PaddleOCR job; an older ECS-based anonymizer) |
| `POST /test-pp-ocr` | `TEST-LAMBDA-OCRv5` | **dead** — target Lambda deleted, early-stage test artifact |

(3 more Lambdas — `VMTB-presignedURLs-audio`, `VMTB-Transcribe-Audio`,
`VMTB-Trigger-transcribe-audio-lambda-function` — belong to the legacy
voice-dictation pipeline, not this one; see
`docs/LEGACY_AND_KNOWN_ISSUES.md`.)

Also present but **orphaned** (API Gateway integrations with no route
attached, pointing at functions that no longer exist —
`VMTB-Audio-Transcribe`, `TEST-PP-OCRv5`, `ocr-demo`): harmless clutter, no
action needed unless doing a general API Gateway cleanup.

## Manual anonymization editor (added 2026-09-14)

Lets a case owner see where automated redaction happened and add/remove
redaction regions after the fact — something the pipeline above could not
support at all, since `VMTB-OCR2ANO-V2` used to hard-delete each page's
unredacted PNG immediately after drawing over it and never persisted where
it drew anything.

**What changed in `VMTB-OCR2ANO-V2`:** before deleting a document's raw
page PNGs from `uploads/{request_id}/data/{item_name}/`, it now copies
them to `uploads/{request_id}/originals/{item_name}/page_N.png` first (S3
object-tagged `ManualRedactionOriginal=true`), and persists every
redaction it draws — bbox (normalized `[0,1]`, not pixels), category,
confidence, style — to the new `case_document_redactions` table, plus one
`case_document_versions` row per regenerated PDF. See
`docs/DATABASE_SCHEMA.md` for the three new tables
(`case_document_redactions`, `case_document_versions`,
`case_document_retention`).

**Editing flow:** the editor renders directly against the retained
*originals* (never the anonymized file), with existing redactions drawn as
overlays — toggling one off reveals the real content instantly, client-side.
Every change in the viewer (redactions, removals, uploads, "Your data") is
batched locally and saved together; how a save is committed and processed is
described in **"Edits and pipeline runs"** below.

**Retention:** originals are kept for 30 days (S3 Lifecycle Rule on the
`ManualRedactionOriginal=true` tag — see `docs/CLOUD_INVENTORY.md`), then
deleted; editing a document becomes unavailable once its originals are
gone (`VMTB-GET-ORIGINALS-V2` returns an empty page list, which the editor
surfaces as a plain message rather than an error). No "final bake" step is
needed at day 30 — the anonymized file is always already up to date, since
every edit regenerates it immediately.

**Security note (deliberate, tracked):** the three new tables have RLS
*disabled* right now, matching this schema's existing baseline, rather
than the service-role-only write model they were originally designed
with — see `docs/LEGACY_AND_KNOWN_ISSUES.md` and
`main/supabase/migrations_deferred/` for why and the ready-to-run
follow-up migration.

New routes/Lambdas: `POST /apply-redaction-changes`,
`POST /trigger-apply-redaction-changes`, `GET /get-originals` — full detail
in `docs/CLOUD_INVENTORY.md`.

## Edits and pipeline runs (added 2026-09-17)

Replaces the earlier "trigger and hope" flow, in which a save was reported as
done once the trigger Lambda answered 200, the UI removed things
optimistically, and overlapping runs raced each other (last Extract to finish
won). That design is what made a removed document come back after a refresh.
Schema: `main/supabase/migrations/20260918_case_pipeline_runs.sql` plus the
`20260918_*` follow-ups (all applied). Scenario tests:
`main/supabase/tests/case_pipeline_runs_test.sql` (run inside a transaction
that always rolls back — see the header of that file).

### Model

1. **A save is one Postgres transaction.** `commit_case_edits(case, session_id,
   changes, delete_files, upload_files, additional_data, empty_action)` locks
   the `cases` row (`FOR UPDATE`, so saves from two tabs queue), writes the
   whole batch (redaction rows, `case_documents` deletes/inserts, notes),
   increments `cases.content_generation`, marks older unfinished runs
   `superseded`, and inserts a `case_pipeline_runs` row whose id **is** the
   client's `session_id` — so a retried or double-clicked save is idempotent.
   The UI shows "Saved" only after this returns.
2. **Lambdas are idempotent materializers of current DB state**, not of their
   own request. `VMTB-TRIGGER-APPLY-REDACTION-CHANGES-V2` async-invokes
   `VMTB-APPLY-REDACTION-CHANGES-V2` with `{run_id}` and returns 202. Apply
   renames every deleted document still live in S3, re-renders every document
   whose regions changed after its latest version, then hands off: runs with
   uploads → `200-OK-V2` → Convert (only the run's `upload_files`; `.txt`
   skipped) → GCP OCR → `VMTB-OCR2ANO-V2`; others → `VMTB-EXTRACT-SUMMARIZE-V2`.
   Extract reads the document set, removed names, "Your data" and live `.txt`
   documents from Postgres.
3. **Stale runs can't write.** Every result goes through a generation-checked
   RPC (`pipeline_write_summary`, `pipeline_mark_step`,
   `pipeline_finish_anonymize`, `pipeline_fail`); a superseded run matches no
   row and stops (`RunSuperseded`). Document PDFs are written with S3
   conditional writes (`IfMatch`/`IfNoneMatch`, re-render on 412, up to 3
   tries) plus an immutable copy at
   `uploads/{request_id}/versions/{name}/g{generation}-{uuid}.pdf`, recorded in
   `case_document_versions.generation`.
4. **Nothing is left "processing" forever.** `get_case_run_state` lazily
   expires runs: `pending` > 2 min → failed `NOT_STARTED`, `running` with no
   update for 30 min → failed `TIMED_OUT`. Every Lambda exception calls
   `pipeline_fail` (`APPLY_FAILED`, `SUMMARY_FAILED`, `NO_CONTENT`,
   `ANONYMIZE_INCOMPLETE` when OCR2ANO didn't publish one of the run's own
   uploads). `retry_case_run` re-runs a failed run (doesn't count toward the
   regenerate cap).

A run's steps are `materialize_done` → `anonymize_done` (upload runs only) →
`summary_done` → `completed`. Statuses: `pending`, `running`, `completed`,
`failed`, `superseded`. A superseding save carries over the unfinished
uploads of the run it replaces (minus any removed in the same save).

### User-facing RPCs (owner-checked, `SECURITY DEFINER`)

| RPC | Refuses with |
|---|---|
| `commit_case_edits` | `NOTHING_TO_SAVE` (incl. identical notes), `DOCUMENT_NOT_READY:<name>` (not anonymized yet), `DUPLICATE_DOCUMENT:<name>`, `INVALID_CHANGE`, `CASE_WOULD_BE_EMPTY` (unless `empty_action='archive'`), `NOT_OWNER` |
| `start_initial_run` | used by case creation (`ReviewCase.tsx`) |
| `start_regeneration` | `RUN_IN_PROGRESS`, `REGENERATION_LIMIT` (5). An edit that supersedes a regeneration refunds it |
| `retry_case_run` | `NOTHING_TO_RETRY` |
| `verify_case_summary(case, generation)` | `SUMMARY_NOT_READY` (a run is active), `STALE_GENERATION`, `PATIENT_DETAILS_MISSING` |
| `save_case_summary_edit(case, generation, …, verify)` | same as verify |
| `get_case_run_state` | — returns the latest run + generations/statuses |

Verifying writes `cases.verified_generation` and `cases.verified_snapshot`
(`summary`, `patient_age`, `patient_sex`, `cancer_type`, `notes`,
`verified_at`). Any later save sends the case back to unverified.

### Frontend

- `services/pipelineService.ts` — RPC wrappers, `startRun(runId)` (POSTs the
  trigger with retries), `PipelineError` + `describePipelineError` (one plain
  message per code; 401/`PGRST301` → "You were signed out…"),
  `announceCaseChanged`/`onCaseChangedElsewhere` (BroadcastChannel).
- `hooks/useDocumentEditSession.ts` — the unsaved draft, in
  **sessionStorage** (per tab; survives refresh and in-app navigation). On
  load it checks `case_pipeline_runs` for the draft's session id: already
  committed → cleared ("already saved"), otherwise restored.
- `hooks/useCaseRunState.ts` — polls `get_case_run_state` (4 s while a run is
  active, 30 s otherwise, paused while the tab is hidden) and reacts to other
  tabs' saves. `hooks/useRunActions.ts` — Start processing / Retry.
- `components/CaseUpdateStatus.tsx` — the one status strip (Reports and the
  summary tab): Saving… · Not saved (+ Try again, or Discard/Save changes when
  a retry alone won't help) · Saved, but processing didn't start (+ Start
  processing) · Unsaved changes (N) · Saved, applying your changes (stage
  text) · Update failed (+ Retry) · Updated, review and verify.
- Empty case: when a save would leave no documents and no text, the Reports
  page asks **Add documents / Add your data / Archive case**; any other exit
  (close, Esc, backdrop, leaving the page) archives — with a `keepalive`
  request on `pagehide` and a localStorage marker applied on the next visit.
- **MTB members** see the last verified version while the owner's changes are
  unverified: `ViewCase.tsx` shows `verified_snapshot` with a banner, and
  `Reports` (`snapshotGeneration`) lists documents live at
  `verified_generation`, each at its newest version with `generation ≤` that,
  signed via `version_keys`.

### Guarantees and their limit

Every app code path and every race between runs is covered by the backend.
The limit is RLS: `case_pipeline_runs` and the document tables have RLS off,
and the `pipeline_*` RPCs are granted to `anon` (the Lambdas use the anon
key), so a hand-crafted client could still write directly. See
`docs/LEGACY_AND_KNOWN_ISSUES.md`.
