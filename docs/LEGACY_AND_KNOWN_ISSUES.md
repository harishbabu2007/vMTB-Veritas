# Legacy Code, Dead Paths, and Known Issues

A catalog of "here be dragons" — things that look like they should be
refactored, consolidated, or fixed, but shouldn't be touched without reading
this first (either because they're intentionally kept as-is, or because
fixing them is a real decision someone needs to make, not a drive-by cleanup).

## Do not touch: legacy voice-dictation pipeline

`main/src/services/voiceTranscriptionService.ts` and
`main/src/components/VoiceRecorder.tsx` are **intentionally kept as-is** and
are unrelated to the meeting-transcription pipeline
(`docs/MEETING_TRANSCRIPTION_PIPELINE.md`) — it's used for dictating case
opinions/comments/questions, not meetings. Do not refactor or "consolidate"
it with the meeting pipeline. Layout around it is done from outside: e.g.
step 2's labelled Dictate button is a wrapper (`.dictate-control` in
`src/index.css`) that restyles the recorder's idle mic button without editing
the component, so its accessible name is still "Start voice recording".

Its flow: insert a `speech_transcriptions` row (`pending`) → POST to
`VMTB-presignedURLs-audio` for an S3 presigned PUT → PUT the raw
`audio/webm` blob to S3 (bucket `vmtb-bedrock-qwen-bucket-v2`, `recordings/`
prefix) → POST to `VMTB-Transcribe-Audio`/
`VMTB-Trigger-transcribe-audio-lambda-function` → poll
`speech_transcriptions` every 3s (10 min timeout) until `completed`/`failed`.
`speech_transcriptions` itself is **not present in either tracked migration
file** — it exists only in the live database, so its schema isn't visible
in this repo (see `docs/DATABASE_SCHEMA.md`).

Call sites (`TranscriptionSource` type): `step2` (case creation),
`general_opinion`, `question`, `answer`, `reply`.

## Dead / unused code paths

- **`AuthContext.tsx` legacy methods** — `login` (plain
  `supabase.auth.signUp`/`signInWithPassword`), `signup` (native Supabase
  signup), `sendPhoneOtp`/`verifyPhoneOtp` (native SMS OTP), and
  `requestPasswordReset` (native email reset link) are all exported but no
  page currently calls them — every real flow goes through Google OAuth or
  WhatsApp OTP instead (see `docs/AUTH_AND_NOTIFICATIONS.md`). Not
  unreachable, just unused; a candidate for removal if confirmed dead for
  good, but flagged rather than removed here.
- **`CheckYourEmail.tsx` (`main/src/pages/`)** — not imported by
  `App.tsx` or any other file and has no route, so it can't be reached. Its
  "Try again" button does a full-page `window.location.href = '/'`
  navigation; if the page is ever wired up, use `navigate('/')` instead.
- **`MeetingService` (`main/src/services/meeting.ts`)** — a
  `WAITING → FIRST_READY → OPENED` polling state machine against
  `jitsi-activation-backend`, instantiated in `MTBDetail.tsx`
  (`meetingServiceRef`) but never actually invoked — the real "Start
  Meeting" button `window.open()`s `VITE_SERVER_LOADER_URL` directly instead.
  See `docs/CASE_AND_MTB_WORKFLOW.md`.
- **`opinion_answers` table** — defined in the schema, but no app code
  found that reads or writes it. `case_opinions` (with its own `parent_id`
  self-reference) appears to be the table actually used for question
  answers and replies. See `docs/DATABASE_SCHEMA.md`.
- **`case_documents.mime_type`** — `CasesContext.tsx` reads a `mime_type`
  column off `case_documents` that does not exist in the migration schema
  (only `type` does) — this read is always `undefined`. Likely a latent,
  harmless bug rather than a real feature gap.
- **`NewCaseStep1_backup.tsx`, `NewCaseStep2_backup.tsx`,
  `ReviewCase_backup.tsx`** — stale backup copies under `main/src/pages/`,
  not routed anywhere. Safe to ignore; candidates for deletion whenever
  someone wants to clean up. (Only `NewCaseStep2_backup.tsx` was confirmed
  present and un-imported on 2026-09-21; it still holds raw palette colours
  and is skipped by `npm run check:theme`.) `main/src/components/Reports.tsx.backup`
  is a `.backup` copy of `Reports.tsx`, likewise dead.
- **Theme gaps left on purpose (2026-09-21).** (1) `VoiceRecorder.css` is
  light-only (pale blue gradient bar, light error box, hardcoded greys) and
  `VoiceRecorder.tsx` has `BAR_COLOR = '#4A90E2'`. Both belong to the
  do-not-touch dictation component above, so they were left byte-identical
  and dark mode is adapted from outside: the `:root.dark .voice-recorder-*`
  rules in `src/index.css` (next to `.dictate-control`) recolour the bar,
  buttons, timer and spinner. Both files are skipped by `check:theme`; a new
  colour added to `VoiceRecorder.css` needs a matching dark override there.
  (2) White text on the brand-blue fill (`--color-primary-solid`, `#4A90E2`)
  is 3.3:1 in light mode — AA only for large text. Kept as the brand colour;
  `check:theme` lists it as a known exception. Darkening that one token fixes
  it.
- **Orphaned AWS API Gateway integrations** — `VMTB-Audio-Transcribe`,
  `TEST-PP-OCRv5`, `ocr-demo` have integrations with no route attached,
  pointing at functions that no longer exist. Harmless clutter. Two routes
  are confirmed dead with their Lambdas deleted: `POST /anonymize` →
  `VMTB-CALL-ECS4ANO-V2` (a pre-GCP-PaddleOCR ECS-based anonymizer) and
  `POST /test-pp-ocr` → `TEST-LAMBDA-OCRv5`. See
  `docs/DOCUMENT_AI_PIPELINE.md`.
- **`VMTB-BEDROCK-DOCKER-US-V1`** (`us-east-1`) — confirmed dead/legacy, an
  early monolithic predecessor to today's split document-AI pipeline. See
  the security finding below.

- **Superseded by the pipeline-run redesign (2026-09-17):**
  `increment_summary_regeneration_count` (replaced by `start_regeneration`),
  the Reports page's direct `POST /delete-reports` call and
  `triggerReprocessing` (removed), and the never-applied
  `case_document_edit_sessions` migration (deleted).

## Security findings (standing, not fixed as part of any doc pass)

- **RLS is disabled on most Postgres tables** (originally counted as 16 of
  19; `profiles` has since been found enabled live — see
  `docs/DATABASE_SCHEMA.md`, other tables not re-checked) — access control is
  enforced almost entirely in application code, not the database. Full
  per-table breakdown: `docs/DATABASE_SCHEMA.md`.
- **RLS is also off on the 3 tables added for the manual anonymization
  editor** (`case_document_redactions`, `case_document_versions`,
  `case_document_retention` — `main/supabase/migrations/20260914_manual_redaction_editor.sql`),
  deliberately, not by oversight: they were originally designed with RLS on
  and writes restricted to the service role (so the browser's anon key
  can't write a redaction/version row without the corresponding S3 write
  actually happening), but that requires pulling the Supabase service-role
  key into 2 Lambdas' env vars — deferred since this feature had no real
  users yet at the time. **Apply
  `main/supabase/migrations_deferred/lock_down_manual_redaction_tables.sql`
  (see that folder's README for the exact steps) before onboarding real
  users to this feature** — don't let this join the list above
  indefinitely.
- **The pipeline-run guarantees stop at RLS.** `case_pipeline_runs` also has
  RLS off, and the `pipeline_*` RPCs (`pipeline_write_summary`,
  `pipeline_fail`, `pipeline_mark_step`, …) are granted to `anon` because the
  Lambdas call them with the anon key — so anyone holding the public anon key
  and a run id could mark a run failed or write a summary for the current
  generation. The owner-facing RPCs do check ownership. The deferred
  lock-down migration now covers `case_pipeline_runs`; closing the `anon`
  grants needs the service-role key in the Lambdas (same prerequisite).
- **A live Supabase service-role JWT is committed in plaintext** in
  `main/supabase/migrations/20260801155807_remote_schema.sql` (lines 585,
  589, 593, inside three commented-out notification triggers), targeting
  project ref `togobilqdevoyijxrexc` — see the "Known issue" section at the
  bottom of `docs/DATABASE_SCHEMA.md` for the full detail, including the
  connection to the `VMTB-Amala`/`vMTB-Veritas` project-ID confusion that
  also shows up in `docs/LOCAL_DEVELOPMENT.md`. **This needs a human
  decision (rotate the key at minimum) — it's flagged here, not
  auto-remediated, per instruction to make doc-only changes.**
- **A plaintext LangSmith API key** sits in the dead
  `VMTB-BEDROCK-DOCKER-US-V1` Lambda's environment variables (`us-east-1`).
  Since that Lambda is confirmed dead, deleting it outright would remove
  the exposed secret with it — flagged for a human decision in
  `docs/CLOUD_INVENTORY.md`, not done here.

## Stale documentation left in place (per user decision, flagged not edited)

Per-service `README.md` files were deliberately left untouched during this
documentation reorg (they stay in their own service directories rather than
moving into `docs/`). Two files in particular are known to be significantly
stale and are flagged here so nobody trusts them at face value:

- **`jitsi-frontend/README.md`** and **`jitsi-frontend/START_HERE.md`** —
  both reference a stale Render URL
  (`https://jitsi-activation-backend.onrender.com` — confirmed superseded by
  Cloud Run, see `docs/CLOUD_INVENTORY.md`), and both link to five
  documentation files (`QUICKSTART.md`, `INTEGRATION.md`, `CHECKLIST.md`,
  `PROJECT_SUMMARY.md`/`COMPLETE_OVERVIEW.md`, and a service-local
  `DEPLOYMENT.md`) that **do not exist anywhere in this repo**.
  `START_HERE.md` in particular is a one-time, AI-generated
  "project-completion report" (self-attributed to "GitHub Copilot"),
  vestigial scaffolding rather than living documentation.
- **`jitsi-frontend/LOCAL_DEV_SETUP.md`** — also references the same stale
  Render URL in its "switching to production" section, and a folder name
  (`Backend-jitsi-activation`) that doesn't match the actual
  `jitsi-activation-backend/` directory.
- **`main/README.md`** — claims the live site is
  `https://vmtb.3billionpairs.com/`, which per the project owner is
  currently accurate for the main app specifically, though other services'
  domains are in active flux during development — don't assume every other
  doc's domain references are equally current; check
  `docs/CLOUD_INVENTORY.md` first.

None of the above were edited as part of this reorg (per-service READMEs
were kept out of scope) — this entry exists so a reader hits the warning
before hitting the stale file.
