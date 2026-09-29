# Database Schema Reference

The full Postgres schema behind `main/`, as it exists in
`main/supabase/migrations/` — `20260801155807_remote_schema.sql` (the baseline
dump, 19 of the 20 objects below), `20260820_meeting_transcripts.sql` (the two
meeting-transcript tables, additive), `20260914_manual_redaction_editor.sql`
(the three `case_document_*` tables),
`20260915_case_verification_and_regeneration.sql` (two additive `cases`
columns plus one RPC), and the account-roles migrations applied
2026-09-27: `20260927_profiles_access_role.sql` (`profiles.role`/
`linked_clinician_id` plus the immutability trigger),
`20260927_case_opinions_questions_rls.sql`, and
`20260927_mtbs_mtb_cases_rls.sql` (RLS for the new roles — see "Row Level
Security" below). This is the single reference
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
| `cases` | Core case record | `case_name`, `patient_name`/`patient_age`/`patient_sex`, `cancer_type`, `summary` (text), `ai_generated_summary` (text, default `''`), `treatment_plan` (text), `summary_status` (default `'verified'` at the column level, but the app always inserts `'processing'` at case creation), `report_status` (default `'not_ready'`), `request_id` (**unique** — the join key to the document-AI pipeline's S3 prefix, see `docs/DOCUMENT_AI_PIPELINE.md`), `owner_id` → `auth.users`, `first_verified_at` (timestamptz, nullable — set **once** on first verification and never cleared; this, not `summary_status`, is what gates tab locking in `ViewCase.tsx`, because `summary_status` cycles back to processing on every regeneration), `summary_regeneration_count` (int, default 0, CHECK `0..5` — the cap on the owner-facing "Regenerate Summary" action), `archived_at` (timestamptz, nullable — set by `archive_case()`, cleared on restore; archived cases have no `mtb_cases` rows, see RPCs below), `content_generation`/`summary_generation` (bigint — bumped by every committed edit / stamped by the run that wrote the summary), `verified_generation` + `verified_snapshot` (jsonb: summary, age, sex, cancer type, notes, verified_at — what MTB members see while newer changes are unverified); see "Edits and pipeline runs" in `docs/DOCUMENT_AI_PIPELINE.md`. `patient_age`/`patient_sex` are **written by the document-AI pipeline**, not by case creation, and are nullable — every read site must handle null. `patient_name` is user-entered only and is **never written by any Lambda**. Non-owner reads should go through `cases_viewer_safe` below, not this table directly (see "Row Level Security"). |
| `cases_viewer_safe` | **View** (`20260922_cases_patient_name_read_guard.sql`, applied live) — every `cases` column unchanged except `patient_name`, which is `null` unless `owner_id = auth.uid()` | `with (security_invoker = false)`, `grant select ... to authenticated`. Closes the concrete patient-name leak (any non-owner route to a case — a bookmarked `/case/:id` with no `?from=mtb`, browser history, the MTB case list — previously returned `patient_name` unfiltered) without touching RLS/grants on the base table, which stays open (tracked separately below). Switched-over read sites: `CasesContext.getCaseById`/`fetchCaseRow`, `MTBDetail`'s shared-case list. Owner-scoped reads (`refetchCases`, `.eq('owner_id', ...)`) and all writes still go through `cases` directly — this view is read-only and is never written to. |
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
| `meeting_transcripts` | One row per transcribed meeting — see `docs/MEETING_TRANSCRIPTION_PIPELINE.md` | keyed by `meeting_id` (**the opaque JVB/Jicofo session id — NOT `meeting_sessions.id` and NOT `mtb_id`**), `mtb_id` nullable FK (written NULL by the proxy; lazily auto-linked by the `get_mtb_transcripts` RPC — not yet applied live, see RPCs below), `status` (`PENDING`→`PROCESSING`→`COMPLETED`/`FAILED`), `transcript_object_key` (GCS path), `mom` (JSONB minutes-of-meeting) |
| `meeting_transcript_segments` | Individual FINAL transcript segments | `meeting_id` → `meeting_transcripts`, `participant_id`, `start_time`/`end_time`, `text`, `provider`; in the `supabase_realtime` publication for a future live-transcript UI |
| `profiles` | User profile, PK = `auth.users.id` | `full_name`, `profession`, `hospital`, `whatsapp_number`, `whatsapp_opt_in`, `whatsapp_verified` (server-set only, by the `verify_whatsapp_otp` Edge Function — also what `AuthContext` now reads to decide whether a signed-in session's registration is actually complete, see "Google OAuth" in `docs/AUTH_AND_NOTIFICATIONS.md`), `role` (text, `NOT NULL DEFAULT 'clinician'`, CHECK `clinician`/`site_data_coordinator`/`mtb_expert` — `20260927_profiles_access_role.sql`), `linked_clinician_id` (uuid → `profiles.id`, CHECK required iff `role = 'site_data_coordinator'`, and CHECK `<> id`; a `BEFORE UPDATE` trigger, `trg_profiles_role_immutable` / `enforce_profile_role_immutable()`, locks both `role` and `linked_clinician_id` forever once `whatsapp_verified` is true — see "Account roles" in `docs/CASE_AND_MTB_WORKFLOW.md` and "WhatsApp OTP" in `docs/AUTH_AND_NOTIFICATIONS.md`), `avatar_key`, `theme_preference` (nullable text, CHECK `light`/`dark`/`system`; **NULL = never chosen → the app shows light**; column applied live as migration `20260918105458`; see "Theme" in `docs/AUTH_AND_NOTIFICATIONS.md`), `onboarding_seen` (jsonb, default `{}` — walkthrough parts finished or closed, `{"<part>": "<timestamp>"}`), `onboarding_ended_at` (timestamptz, nullable — walkthrough over: stopped, all parts seen, or the account predates it; `20260918_profiles_onboarding.sql` backfilled every existing row). TEMPORARY (testing, `20260919_onboarding_test_restart.sql`): `onboarding_test_restart` (bool, default false — restart the walkthrough on every new login) and `onboarding_test_reset_for` (timestamptz — the sign-in it last restarted for). See "Onboarding walkthrough" in `docs/CASE_AND_MTB_WORKFLOW.md`. |
| `feedback` | User feedback submissions | `content`, `status` (CHECK: `pending`/`reviewed`/`resolved`/`dismissed`) |
| `whatsapp_otps` | OTP records backing the WhatsApp OTP Edge Functions | `phone`, `otp_hash` (never the raw code), `expires_at`, `verified`, `attempts`/`max_attempts` |
| `speech_transcriptions` | Backs the **legacy voice-dictation pipeline** (`voiceTranscriptionService.ts`) | **Not present in either migration file** — it must have been created directly against the live database (dashboard, or a migration never committed here), so its schema isn't visible in this repo. Treat as untracked; don't assume its columns without checking the live project. Its `source` CHECK constraint (`speech_transcriptions_source_check`) is the one piece now managed by a tracked migration (`20260916_case_archive_and_feedback_voice.sql`): `step2`, `general_opinion`, `question`, `answer`, `reply`, `feedback`. |
| `case_document_redactions` | Manual anonymization editor — one row per redaction region, automated or manual (`20260914_manual_redaction_editor.sql`) | keyed by `(case_id, request_id, document_name)`, not `case_documents.id`; `page_number` (**0-indexed** — the `N` in `page_N.png`, so the first page is `0`; the same number `VMTB-GET-ORIGINALS-V2` returns for each original page, so any UI that counts pages from 1 must translate), `bbox` (JSONB, normalized `[0,1]`), `category`/`confidence` (null for manual), `style` (CHECK: `blur`/`whiteout`/`blackout`), `source` (CHECK: `automated_text`/`automated_visual`/`manual`), `is_active`, `removed_at`/`removed_by` (soft-delete, audit trail) |
| `case_document_versions` | Manual anonymization editor — version history for a document's regenerated PDF | `version`, `s3_key` (current version points at the canonical `data/` key; superseded ones point at their archived `versions/` key), `redaction_id` → `case_document_redactions` (null for the original automated version), `UNIQUE(case_id, document_name, version)` |
| `case_document_retention` | Manual anonymization editor — tracks the 30-day S3 Lifecycle clock on retained originals | `PRIMARY KEY (case_id, document_name)`, `originals_retained_at` (re-stamped on every fresh write, not just the first) |

## Row Level Security — what's actually enforced

This is the single most important thing in this file: **most tables above
still have RLS off**, despite most of them having `CREATE POLICY` statements
defined. A policy with no `ENABLE ROW LEVEL SECURITY` on its table is inert
— Postgres never evaluates it, and the table's blanket `GRANT ALL ... TO
anon, authenticated, service_role` (present on every table in the baseline
migration) applies unfiltered instead. Access control is still enforced
almost entirely in **application code**
(`CasesContext`/`AuthContext` ownership checks like `.eq('owner_id',
user.id)`) for most tables — `case_opinions`, `case_questions`, `mtbs`, and
`mtb_cases` are the exception (below): RLS was enabled on these four
2026-09-27, specifically to enforce the new account-roles restrictions
server-side (see "Account roles" in `docs/CASE_AND_MTB_WORKFLOW.md`), not as
a general lock-down.

**RLS enabled (`profiles`, `case_opinions`, `case_questions`, `mtbs`,
`mtb_cases`, + the 3 below):**
- `case_opinions`, `case_questions` — enabled live 2026-09-27
  (`20260927_case_opinions_questions_rls.sql`). Existing dormant
  `USING (true)` SELECT / owner-or-author-scoped INSERT policies became
  active; added owner-scoped DELETE and author-scoped opinion UPDATE
  policies to match real app behavior (neither existed before); layered a
  `RESTRICTIVE` INSERT policy on each blocking `role = 'site_data_coordinator'`
  from posting opinions or adding questions, even via a direct API call.
- `mtbs`, `mtb_cases` — enabled live 2026-09-27
  (`20260927_mtbs_mtb_cases_rls.sql`). Existing dormant SELECT/INSERT
  policies on `mtbs` became active; added an owner-scoped UPDATE policy
  (rename/notification-toggle, previously unguarded) and, on `mtb_cases`, an
  owner-inclusive SELECT policy (the old dormant one excluded MTB owners
  entirely) plus INSERT/DELETE policies matching current wide-open app
  behavior; layered a `RESTRICTIVE` INSERT policy on each blocking
  `role = 'mtb_expert'` from creating an MTB or adding a case to one, even
  via a direct API call. MTB Expert's meeting-start restriction has **no**
  equivalent server-side enforcement — it's client-side-only (disabled
  button); see the security finding in `docs/LEGACY_AND_KNOWN_ISSUES.md`.
- `profiles` — **RLS is enabled live** (checked against the live project on
  2026-09-21; the older revision of this doc said it was not). Policies:
  select-all (`Users can view all profiles`, also `profiles_select_own`),
  and own-row (`id = auth.uid()`) INSERT / UPDATE / DELETE — several
  overlapping duplicates. So one user cannot write another user's row
  (including `theme_preference`) through the API, and `anon` matches no write
  policy. The `profiles_*_own` policies exist only live: the tracked baseline
  migration (`20260801155807_remote_schema.sql`) has just the four older
  `Users can …` policies, so the repo has drifted from the live database
  here.

**Verified live 2026-09-29** (`pg_class.relrowsecurity`, direct query, not
`get_advisors`), because the Realtime work depends on it — which tables are
safe to subscribe to *unfiltered* is decided entirely by this split, since
Realtime evaluates each subscriber's SELECT policies only where RLS is on:

- **RLS on:** `mtbs`, `mtb_cases`, `case_opinions`, `case_questions`,
  `profiles`.
- **RLS off:** `cases`, `case_documents`, `case_pipeline_runs`,
  `case_treatment_plans`, `case_treatment_followups`, `case_follow_ups`,
  `case_additional_documents`, `opinion_answers`, `mtb_members`,
  `meeting_sessions`.

That confirms the two lists below rather than changing them. `forcerowsecurity`
is off everywhere, so the table owner and the service role still bypass RLS on
the enabled tables. Not covered by this check: `feedback`,
`meeting_transcripts`, `meeting_transcript_segments`, `meeting_participants`,
`whatsapp_otps`, the three `case_document_*` tables, and
`speech_transcriptions` — those claims here remain as previously recorded.
`case_pipeline_runs` had not been listed in this section at all before; it is
RLS-off, like the rest of the pipeline tables.
- `feedback` — insert-own, select-own policies actually apply.
- `meeting_transcripts`, `meeting_transcript_segments` — MTB-member-scoped
  SELECT policies apply, but the app never reads these tables directly for
  this purpose anyway — it goes through the `get_mtb_transcripts` RPC (own
  `SECURITY DEFINER` owner-or-member check, bypassing RLS), so these
  policies stay inert either way. `mtb_id` being NULL until that RPC's
  auto-link runs (see `docs/MEETING_TRANSCRIPTION_PIPELINE.md`) would have
  made them inert regardless. Writes are service-role-only via grants
  (service role bypasses RLS).

**RLS NOT enabled — wide open at the table level:**
- `cases`, `case_documents`, `mtb_members`, `meeting_sessions`,
  `meeting_participants` — all have `CREATE POLICY` statements defined
  (mostly `USING (true)` "view all" plus scoped inserts) but RLS is never
  switched on for the table, so none of those policies actually run. Any
  authenticated (or, per the blanket grant, even `anon`) client can
  read/write these tables directly, relying purely on the app not doing
  anything malicious client-side.
- `case_opinions`, `case_questions`, `mtbs`, `mtb_cases` — **no longer in
  this group**: RLS enabled live 2026-09-27 (see above).
  **`cases`'s one confirmed sensitive column, `patient_name`, has a narrow
  mitigation**: the app's non-owner-reachable reads go through
  `cases_viewer_safe` (above), which nulls it for non-owners — this closes
  that one concrete leak without enabling RLS on `cases` itself, which
  remains fully open at the table level (a direct REST/anon query against
  `cases` still returns `patient_name` unfiltered).
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

## Realtime publication

A `postgres_changes` subscription on a table that is **not** in the
`supabase_realtime` publication reaches `SUBSCRIBED` and then silently never
fires — there is no error, so client code looks correct and does nothing.
Check with `select tablename from pg_publication_tables where pubname =
'supabase_realtime'` before assuming a live-update feature is broken in the
client.

Published as of 2026-09-29: `meeting_transcript_segments`
(`20260820_meeting_transcripts.sql`), `cases` and `case_opinions`
(`20260929_realtime_cases_and_opinions.sql`), and — once
`20260929_realtime_mtb_and_questions.sql` is applied — `mtb_cases`, `mtbs`
and `case_questions`.

Two constraints that decide what a subscription can actually do:

- **RLS is the only per-subscriber filter.** Realtime evaluates the
  subscriber's SELECT policies for RLS-on tables, so `mtb_cases`/`mtbs`/
  `case_questions` can be subscribed unfiltered and are still server-scoped.
  For an RLS-off table there is no scoping at all: publishing it streams
  every row to every authenticated subscriber, which is why the pipeline and
  treatment tables are deliberately left unpublished. A client-side
  `filter:` is a delivery convenience, never an access boundary.
- **Deletes are the hard case, and mostly can't be handled by payload.**
  Read `realtime.apply_rls()` if in doubt — it is the authority, and two of
  its rules govern everything here. First, `if not is_rls_enabled or action =
  'DELETE'` — a DELETE is delivered *without* an RLS check, so any subscriber
  to a published table receives every delete on it. Second, the old_record is
  built with `and ( not is_rls_enabled or (c).is_pkey )` — on an **RLS-enabled**
  table a DELETE's payload is stripped to **primary-key columns only**,
  whatever the replica identity is. So for `mtb_cases` (PK = surrogate `id`)
  a removal arrives as one opaque uuid naming neither board nor case.
  - Replica identity still matters, for a different reason: the subscription's
    `filter:` is matched against the old row, so `REPLICA IDENTITY FULL` on
    `mtb_cases` is what lets an `mtb_id=eq.` filter match a delete at all. The
    filter then carries the information the payload can't — a delivered event
    *is* that board — which is why `MTBDetail` subscribes per board and
    re-reads instead of patching. Don't apply FULL to `cases`; its rows carry
    the full summary text.
  - On an **RLS-disabled** table the payload isn't stripped, so a delete
    carries whatever the replica identity holds — for `cases` (default
    identity) that is `{id}` and nothing else, which is why the `cases` DELETE
    subscription in `CasesContext` can safely run unfiltered: a bare uuid
    discloses nothing, and a filtered one would never match.
- **Payloads are raw base-table rows.** Realtime replays the WAL row, so it
  cannot route through `cases_viewer_safe`, and RLS cannot help: RLS filters
  rows, not columns. A `cases` subscription therefore always ships
  `patient_name`. That is why no MTB-member-facing surface subscribes to
  `cases` — see the Realtime section in `docs/LEGACY_AND_KNOWN_ISSUES.md`.

## Triggers

- `update_updated_at_column()` — a generic `BEFORE UPDATE` trigger function,
  applied to `case_treatment_plans`, `feedback`, `meeting_participants`,
  `meeting_sessions`, `profiles`, `meeting_transcripts`,
  `meeting_transcript_segments`.
- `trg_cases_delete_role` / `enforce_case_delete_role()` (`SECURITY DEFINER`,
  `20260928_sdc_archive_not_delete.sql`) — `BEFORE DELETE ON cases`. Raises if
  the caller's `profiles.role` is `site_data_coordinator`: that role may
  archive a case but never delete one. A trigger rather than an RLS policy
  because RLS is off on `cases`, so a DELETE policy would never be evaluated.
  `auth.uid()` is NULL for the service role and the pipeline Lambdas, so it
  only fires for a real signed-in coordinator. It guards the `cases` row only
  — `deleteCase` removes child rows (`case_opinions`, `case_documents`, …)
  first, and those tables are open to every role anyway (see
  `docs/LEGACY_AND_KNOWN_ISSUES.md`).
- `trg_profiles_role_immutable` / `enforce_profile_role_immutable()`
  (`SECURITY DEFINER`, `20260927_profiles_access_role.sql`) — `BEFORE UPDATE
  ON profiles`. While `OLD.whatsapp_verified IS TRUE`, raises an exception if
  the statement changes `role` or `linked_clinician_id`; a no-op before that
  (registration still in flight). This is the one place those two columns
  can ever be written intentionally: the `verify_whatsapp_otp` Edge
  Function's Step B3 upsert, which sets `role`/`linked_clinician_id` and
  flips `whatsapp_verified` to `true` in the same statement. Because it's a
  plain `public` schema function, PostgREST auto-exposes it as an
  anon/authenticated-callable RPC (`get_advisors` flags this) — harmless,
  since calling it outside trigger context has no `OLD`/`NEW` to act on.
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

**`get_mtb_transcripts(p_mtb_id UUID) → SETOF meeting_transcripts + session_id`**
(`SECURITY DEFINER`, `20260924_get_mtb_transcripts_session_link.sql`) — read
side for `main/`'s Meeting History UI; owner-or-member gated, and lazily
auto-links `mtb_id` by time-window matching against `meeting_sessions`.
**Not yet applied to the live database** (checked 2026-09-25). Full detail,
including the access-gate fix it makes over the previous version of this
function: `docs/MEETING_TRANSCRIPTION_PIPELINE.md`.

**`effective_owner_id() → uuid`** (`STABLE`, invoker-rights,
`20260927_effective_owner_id_rls.sql`) — the SQL mirror of `AuthContext`'s
`effectiveOwnerId`: returns `COALESCE(linked_clinician_id, id)` for
`auth.uid()`, i.e. the linked clinician for a Site Data Coordinator and the
caller's own id for everyone else. Exists because the RLS policies added
earlier the same day encoded "the actor is the owner" (`auth.uid() =
owner_id`), which rejects every SDC write to `mtbs` and hides the clinician's
`mtb_cases` rows from them. Used by the `mtbs` INSERT/UPDATE policies, the
`mtb_cases` owner SELECT policy, and the two case-owner DELETE policies;
deliberately **not** used by the `mtb_members`-based policies or the
`RESTRICTIVE` role-blocking policies, which are correctly actor-scoped.
**Applied live 2026-09-28** and verified via `pg_policies` (the `mtbs`
INSERT/UPDATE, `mtb_cases` owner SELECT, and both case-owner DELETE policies
reference it; nothing else does).

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
`20260916_case_archive_and_feedback_voice.sql`, owner check amended by
`20260928_sdc_archive_not_delete.sql`) — archives the caller's own active case
and deletes all of its `mtb_cases` rows in one transaction. Returns the
updated row, or no rows if nothing matched (not owned, missing, or already
archived). Matches on `owner_id = effective_owner_id()`, **not** `auth.uid()`:
with `auth.uid()` a Site Data Coordinator never matched, so archiving failed
for them with "Only the owner can archive this case". Restoring is a plain
owner-scoped update (`archived_at = NULL`) and deliberately does **not**
re-create MTB links. Granted to `authenticated`.

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
