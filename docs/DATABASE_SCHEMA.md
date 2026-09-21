# Database Schema Reference

The full Postgres schema behind `main/`, as it exists in
`main/supabase/migrations/` — `20260801155807_remote_schema.sql` (the baseline
dump, 19 of the 20 objects below), `20260820_meeting_transcripts.sql` (the two
meeting-transcript tables, additive), `20260914_manual_redaction_editor.sql`
(the three `case_document_*` tables) and
`20260915_case_verification_and_regeneration.sql` (two additive `cases`
columns plus one RPC). This is the single reference
for what table holds what; nothing here needs to be re-derived from the SQL
or from app code.

Project: `vMTB-Veritas` (`gwvqxetjheveelqrkjhg`), org `VMTB.in` — see
`docs/CLOUD_INVENTORY.md`. **Do not confuse with `VMTB-Amala`
(`togobilqdevoyijxrexc`)**, an unrelated project in the same org — see the
"Known issue" callout at the bottom of this file, which is exactly about that
confusion.

## Tables and views

| Table / view | Purpose | Key columns |
|---|---|---|
| `cases` | Core case record | `case_name`, `patient_name`/`patient_age`/`patient_sex`, `cancer_type`, `summary` (text), `ai_generated_summary` (text, default `''`), `treatment_plan` (text), `summary_status` (default `'verified'` at the column level, but the app always inserts `'processing'` at case creation), `report_status` (default `'not_ready'`), `request_id` (**unique** — the join key to the document-AI pipeline's S3 prefix, see `docs/DOCUMENT_AI_PIPELINE.md`), `owner_id` → `auth.users`, `first_verified_at` (timestamptz, nullable — set **once** on first verification and never cleared; this, not `summary_status`, is what gates tab locking in `ViewCase.tsx`, because `summary_status` cycles back to processing on every regeneration), `summary_regeneration_count` (int, default 0, CHECK `0..5` — the cap on the owner-facing "Regenerate Summary" action), `archived_at` (timestamptz, nullable — set by `archive_case()`, cleared on restore; archived cases have no `mtb_cases` rows, see RPCs below), `content_generation`/`summary_generation` (bigint — bumped by every committed edit / stamped by the run that wrote the summary), `verified_generation` + `verified_snapshot` (jsonb: summary, age, sex, cancer type, notes, verified_at — what MTB members see while newer changes are unverified); see "Edits and pipeline runs" in `docs/DOCUMENT_AI_PIPELINE.md`. `patient_age`/`patient_sex` are **written by the document-AI pipeline**, not by case creation, and are nullable — every read site must handle null. `patient_name` is user-entered only and is **never written by any Lambda**. |
| `case_documents` | Metadata for uploaded clinical files — maintained by `commit_case_edits` (uploads insert, removals soft-delete) | `file_name`, `size`, `type`, `storage_path` (the S3 key under `uploads/{request_id}/data/`), `document_name` (set by a BEFORE INSERT trigger), `added_generation`, `deleted_generation`/`deleted_at`/`deleted_by`, `deleted_s3_key` (where the materializer moved the file). A removed name can be re-added as a new row |
| `case_pipeline_runs` | One row per document-edit/regenerate/retry pipeline run (`20260918_case_pipeline_runs.sql`) | `id` (= the client save's session id, idempotency key), `case_id`, `generation` (unique per case), `kind` (initial/edit/regenerate/retry), `status` (pending/running/completed/failed/superseded), `materialize_done`/`anonymize_done`/`summary_done`, `has_uploads`/`upload_files`, `error_code`/`error`, `created_by` |
| `case_additional_documents` | The free-text "case explanation" typed at creation — content lives directly in Postgres, no S3 involved | `document_title`, `document_data`; `UNIQUE(case_id)` (`one_document_per_case`) |
| `case_questions` | Owner-authored "questions for experts" | `question_text` |
| `case_opinions` | Threaded discussion (opinions, question answers, replies) | `opinion_text`, `question_id` (nullable), `parent_id` (nullable, self-referential — replies), `mtb_id` (nullable — scopes the opinion/answer to one MTB) |
| `opinion_answers` | A second answers table — **appears unused**; no app code found that reads or writes it (see Known issues) | `opinion_id`, `question_id`, `answer_text` |
| `case_follow_ups` | Free-text follow-up notes, distinct from the structured `case_treatment_followups` below | `follow_up`, `created_by` |
| `case_treatment_plans` | Structured MTB treatment-plan record, one per case | `vmtb_discussion_date`, `participants[]`, consensus/evidence fields (`amp_level_of_evidence`, `escat_level`, …), implementation tracking (`is_treatment_implemented`, dates, `non_implementation_reason` — CHECK enforces the reason is set iff not implemented); `UNIQUE(case_id)` |
| `case_treatment_followups` | Longitudinal follow-up entries against a treatment plan | `treatment_plan_id` → `case_treatment_plans`, `followup_date`, `disease_progression_date`, `current_patient_status` (CHECK: `Alive`/`Deceased`), `discontinuation_or_ltfu_reason` |
| `mtbs` | MTB boards | `name` (**globally unique**), `owner_id`, `join_code` (unique), `notification_enabled` (default `true` — gates the WhatsApp "meeting started" notification) |
| `mtb_members` | Membership join table | `UNIQUE(mtb_id, user_id)` |
| `mtb_cases` | Case-sharing join table | `UNIQUE(mtb_id, case_id)` |
| `mtb_meeting_stats` | **View**, not a table — aggregates `meeting_sessions` per MTB | total/completed meetings, avg/total duration, avg/peak participants |
| `meeting_sessions` | One row per Jitsi meeting (written by `jitsi-frontend`'s `meetingAnalytics.ts`) | `mtb_id`, `room_name`, `started_at`/`ended_at`, `total_duration_seconds`, `max_participants`, `status` (CHECK: `active`/`ended`), `last_heartbeat` |
| `meeting_participants` | Per-participant attendance within a session | `meeting_session_id` → `meeting_sessions`, `participant_id`, `display_name`, `joined_at`/`left_at`, `duration_seconds`, `left_reason` |
| `meeting_transcripts` | One row per transcribed meeting — see `docs/MEETING_TRANSCRIPTION_PIPELINE.md` | keyed by `meeting_id` (**the opaque JVB/Jicofo session id — NOT `meeting_sessions.id` and NOT `mtb_id`**), `mtb_id` nullable FK (always NULL in the MVP), `status` (`PENDING`→`PROCESSING`→`COMPLETED`/`FAILED`), `transcript_object_key` (GCS path), `mom` (JSONB minutes-of-meeting) |
| `meeting_transcript_segments` | Individual FINAL transcript segments | `meeting_id` → `meeting_transcripts`, `participant_id`, `start_time`/`end_time`, `text`, `provider`; in the `supabase_realtime` publication for a future live-transcript UI |
| `profiles` | User profile, PK = `auth.users.id` | `full_name`, `profession`, `hospital`, `whatsapp_number`, `whatsapp_opt_in`, `whatsapp_verified`, `avatar_key`, `theme_preference` (nullable text, CHECK `light`/`dark`/`system`; **NULL = never chosen → the app shows light**; column applied live as migration `20260918105458`; see "Theme" in `docs/AUTH_AND_NOTIFICATIONS.md`), `onboarding_seen` (jsonb, default `{}` — walkthrough parts finished or closed, `{"<part>": "<timestamp>"}`), `onboarding_ended_at` (timestamptz, nullable — walkthrough over: stopped, all parts seen, or the account predates it; `20260918_profiles_onboarding.sql` backfilled every existing row). TEMPORARY (testing, `20260919_onboarding_test_restart.sql`): `onboarding_test_restart` (bool, default false — restart the walkthrough on every new login) and `onboarding_test_reset_for` (timestamptz — the sign-in it last restarted for). See "Onboarding walkthrough" in `docs/CASE_AND_MTB_WORKFLOW.md`. |
| `feedback` | User feedback submissions | `content`, `status` (CHECK: `pending`/`reviewed`/`resolved`/`dismissed`) |
| `whatsapp_otps` | OTP records backing the WhatsApp OTP Edge Functions | `phone`, `otp_hash` (never the raw code), `expires_at`, `verified`, `attempts`/`max_attempts` |
| `speech_transcriptions` | Backs the **legacy voice-dictation pipeline** (`voiceTranscriptionService.ts`) | **Not present in either migration file** — it must have been created directly against the live database (dashboard, or a migration never committed here), so its schema isn't visible in this repo. Treat as untracked; don't assume its columns without checking the live project. Its `source` CHECK constraint (`speech_transcriptions_source_check`) is the one piece now managed by a tracked migration (`20260916_case_archive_and_feedback_voice.sql`): `step2`, `general_opinion`, `question`, `answer`, `reply`, `feedback`. |
| `case_document_redactions` | Manual anonymization editor — one row per redaction region, automated or manual (`20260914_manual_redaction_editor.sql`) | keyed by `(case_id, request_id, document_name)`, not `case_documents.id`; `page_number` (**0-indexed** — the `N` in `page_N.png`, so the first page is `0`; the same number `VMTB-GET-ORIGINALS-V2` returns for each original page, so any UI that counts pages from 1 must translate), `bbox` (JSONB, normalized `[0,1]`), `category`/`confidence` (null for manual), `style` (CHECK: `blur`/`whiteout`/`blackout`), `source` (CHECK: `automated_text`/`automated_visual`/`manual`), `is_active`, `removed_at`/`removed_by` (soft-delete, audit trail) |
| `case_document_versions` | Manual anonymization editor — version history for a document's regenerated PDF | `version`, `s3_key` (current version points at the canonical `data/` key; superseded ones point at their archived `versions/` key), `redaction_id` → `case_document_redactions` (null for the original automated version), `UNIQUE(case_id, document_name, version)` |
| `case_document_retention` | Manual anonymization editor — tracks the 30-day S3 Lifecycle clock on retained originals | `PRIMARY KEY (case_id, document_name)`, `originals_retained_at` (re-stamped on every fresh write, not just the first) |

## Row Level Security — what's actually enforced

This is the single most important thing in this file: **only 3 of the 22
tables above have RLS actually enabled**, despite most of them having
`CREATE POLICY` statements defined. A policy with no `ENABLE ROW LEVEL
SECURITY` on its table is inert — Postgres never evaluates it, and the
table's blanket `GRANT ALL ... TO anon, authenticated, service_role` (present
on every table in the baseline migration) applies unfiltered instead. Access
control today is enforced almost entirely in **application code**
(`CasesContext`/`AuthContext` ownership checks like `.eq('owner_id',
user.id)`), not the database.

**RLS enabled (`profiles` + the 3 below):**
- `profiles` — **RLS is enabled live** (checked against the live project on
  2026-09-21; the older revision of this doc said it was not). Policies:
  select-all (`Users can view all profiles`, also `profiles_select_own`),
  and own-row (`id = auth.uid()`) INSERT / UPDATE / DELETE — several
  overlapping duplicates. So one user cannot write another user's row
  (including `theme_preference`) through the API, and `anon` matches no write
  policy. The `profiles_*_own` policies exist only live: the tracked baseline
  migration (`20260801155807_remote_schema.sql`) has just the four older
  `Users can …` policies, so the repo has drifted from the live database
  here. **Not re-checked this session:** whether the other tables listed as
  RLS-off below still are, so treat the "3 of 22" / "16 of 19" counts in this
  doc, `docs/README.md` and `docs/LEGACY_AND_KNOWN_ISSUES.md` as unverified.
- `feedback` — insert-own, select-own policies actually apply.
- `meeting_transcripts`, `meeting_transcript_segments` — MTB-member-scoped
  SELECT policies apply, but are currently inert in practice because
  `mtb_id` is always NULL in the MVP (see `docs/MEETING_TRANSCRIPTION_PIPELINE.md`);
  writes are service-role-only via grants (service role bypasses RLS).

**RLS NOT enabled (19 tables) — wide open at the table level:**
- `cases`, `case_documents`, `case_questions`, `case_opinions`, `mtbs`,
  `mtb_members`, `mtb_cases`, `meeting_sessions`, `meeting_participants` —
  all have `CREATE POLICY` statements defined (mostly `USING (true)` "view
  all" plus scoped inserts) but RLS is never switched on for the table, so
  none of those policies actually run. Any authenticated (or, per the
  blanket grant, even `anon`) client can read/write these tables directly,
  relying purely on the app not doing anything malicious client-side.
- `profiles` — **no longer in this group**: verified RLS-enabled live (see
  above). Note `whatsapp_number` (PII) is still readable by every signed-in
  user through the view-all SELECT policy.
- `case_additional_documents`, `case_follow_ups`, `case_treatment_plans`,
  `case_treatment_followups`, `opinion_answers`, `whatsapp_otps` — **no
  policies defined at all**, and no RLS — fully open via the blanket grants.
  This subset is the most sensitive: `whatsapp_otps` holds OTP hashes, and
  `case_treatment_plans`/`case_treatment_followups` hold clinical treatment
  data.
- `case_document_redactions`, `case_document_versions`,
  `case_document_retention` — same "policies defined, RLS not switched on"
  pattern as the first group above, but this one is **deliberate and
  tracked**, not inherited baseline debt: these were originally designed
  with RLS on and writes restricted to the service role, relaxed to match
  this table's baseline on purpose since the manual anonymization editor
  had no real users yet at the time. See `docs/LEGACY_AND_KNOWN_ISSUES.md`
  and `main/supabase/migrations_deferred/` for the ready-to-run migration
  that locks this back down.

**To enable enforcement** for the 10 tables that already have policies
defined (dead code, ready to activate): `ALTER TABLE <table> ENABLE ROW
LEVEL SECURITY;`. Note most existing policies use `USING (true)` for reads
("view all"), so enabling RLS alone would formally turn it on without
actually restricting access — the policies themselves would need tightening
first for `cases`/`profiles`/etc. to be meaningfully protected. See
`docs/LEGACY_AND_KNOWN_ISSUES.md` for the standing security-finding list this
belongs to.

## Triggers

- `update_updated_at_column()` — a generic `BEFORE UPDATE` trigger function,
  applied to `case_treatment_plans`, `feedback`, `meeting_participants`,
  `meeting_sessions`, `profiles`, `meeting_transcripts`,
  `meeting_transcript_segments`.
- Three notification triggers exist live but are captured as **commented-out**
  `CREATE OR REPLACE TRIGGER` statements in the baseline dump (`pg_dump` can't
  fully round-trip triggers that call the `supabase_functions.http_request`
  extension function):
  - `"Case Created Notification"` — `AFTER INSERT ON mtb_cases` → `notify_case_created`
  - `"notify_meeting"` — `AFTER INSERT ON meeting_sessions` → `notify_meeting`
  - `"notify_opinion_added"` — `AFTER INSERT ON case_opinions` → `notify_opinion_added`

  See `docs/AUTH_AND_NOTIFICATIONS.md` for what each notification Edge
  Function does.

## RPCs

**Meeting-transcript status machine** — all `SECURITY DEFINER`, defined in
`20260820_meeting_transcripts.sql`: `ensure_meeting_transcript`,
`claim_meeting_transcript`, `complete_meeting_transcript`,
`fail_meeting_transcript`. Full detail in
`docs/MEETING_TRANSCRIPTION_PIPELINE.md`.

**Case edits and pipeline runs** — all `SECURITY DEFINER`, defined in
`20260918_case_pipeline_runs.sql` (+ `20260918_*` follow-ups). Owner-checked,
granted to `authenticated`: `commit_case_edits`, `start_initial_run`,
`start_regeneration` (the 5-per-case regenerate cap), `retry_case_run`,
`verify_case_summary`, `save_case_summary_edit`, `get_case_run_state`. Called
by the Lambdas with the anon key (granted to `anon`): `pipeline_begin`,
`pipeline_is_current`, `pipeline_mark_step`, `pipeline_mark_anonymized`,
`pipeline_finish_anonymize`, `pipeline_write_summary`, `pipeline_fail`. Error
codes and semantics: "Edits and pipeline runs" in
`docs/DOCUMENT_AI_PIPELINE.md`.

**`increment_summary_regeneration_count(p_case_id UUID) → INTEGER`**
(`20260915_…`) — the previous regenerate-cap RPC; **no longer called by the
app** (replaced by `start_regeneration`). Returns the new count, or NULL when
the cap is reached or the case isn't the caller's.

**`archive_case(p_case_id UUID) → SETOF cases`** (`SECURITY DEFINER`,
`20260916_case_archive_and_feedback_voice.sql`) — archives the caller's own
active case and deletes all of its `mtb_cases` rows in one transaction.
Returns the updated row, or no rows if nothing matched (not owned, missing, or
already archived). Restoring is a plain owner-scoped update
(`archived_at = NULL`) and deliberately does **not** re-create MTB links.
Granted to `authenticated`.

**`mark_onboarding_seen(p_key TEXT) → void`** (`SECURITY INVOKER`,
`20260918_profiles_onboarding.sql`) — merges `{p_key: now()}` into the
caller's `profiles.onboarding_seen`, so two tabs marking different walkthrough
parts can't overwrite each other. Runs under the caller's profiles RLS (own
row only). Granted to `authenticated`.

**`onboarding_test_restart_if_new_sign_in() → boolean`** (`SECURITY DEFINER`,
`search_path=''`, TEMPORARY, `20260919_onboarding_test_restart.sql`) — for the
caller only: if their profile has `onboarding_test_restart` and
`auth.users.last_sign_in_at` differs from `onboarding_test_reset_for`, clears
`onboarding_seen` / `onboarding_ended_at` and records the sign-in. Definer only
to read the caller's own `last_sign_in_at`. Granted to `authenticated`; revoked
from `anon`.

## Known issue: a live secret is committed in the baseline migration

`main/supabase/migrations/20260801155807_remote_schema.sql` lines 585, 589,
593 contain the three commented-out notification triggers above, and each one
hardcodes, in plaintext, a full Supabase **service-role JWT** as a bearer
token, plus the target URL `https://togobilqdevoyijxrexc.supabase.co/...`.

Two things to flag here, not silently fix:
1. **A service-role key is committed to this git repository.** Treat it as
   compromised — rotate it in Supabase (Project Settings → API) regardless
   of whether the project it belongs to is even this one.
2. **The project ref in that URL/JWT is `togobilqdevoyijxrexc`** — the exact
   ID `docs/CLOUD_INVENTORY.md` identifies as **`VMTB-Amala`, a different,
   unrelated Supabase project in the same org.** This means either (a) this
   migration dump was taken from the wrong project and the triggers as
   written would never have fired against `vMTB-Veritas` in the first place,
   or (b) `vMTB-Veritas` and `VMTB-Amala`'s identities have been mixed up
   somewhere in this repo's history. This is the same project-ID confusion
   flagged in `docs/LOCAL_DEVELOPMENT.md` (which also references
   `togobilqdevoyijxrexc`) — it isn't an isolated typo, it traces back to
   this migration file. Needs a human decision, not a doc-only fix; see
   `docs/LEGACY_AND_KNOWN_ISSUES.md`.
