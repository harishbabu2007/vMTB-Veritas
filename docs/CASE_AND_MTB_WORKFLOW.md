# Case Creation, Viewing, and MTB Workflow

The clinical core of `main/`: how a case gets created, how it moves through
AI processing, and how a multidisciplinary team collaborates on it inside an
MTB. All state lives in `main/src/context/CasesContext.tsx` (the central
data-access layer for `cases`, `mtbs`, and every related table) and
`main/src/context/CaseCreationContext.tsx` (pure client-side draft state for
the creation wizard).

## Account roles and routing

Every account has one **permanent** `role`, chosen once at signup and
locked forever by a DB trigger the moment registration completes (`profiles`
schema detail: `docs/DATABASE_SCHEMA.md`). Everything below this section
describes the **Clinician** experience unless a role is called out.

- **Clinician** — the original, full-access role. Unprefixed routes
  (`/my-cases`, `/mtbs`, `/case/:id`, …).
- **Site Data Coordinator (SDC)** — an assistant acting *on behalf of* one
  linked clinician (`profiles.linked_clinician_id`, chosen at signup via
  `findClinicianByPhone`, see `docs/AUTH_AND_NOTIFICATIONS.md`). Full parity
  with Clinician for creating and editing cases. **May archive a case but not
  delete one** — archiving is reversible so it stays available; deleting isn't,
  so it belongs to the clinician alone. Enforced in three places: the Danger
  zone section is dropped entirely for this role, `CasesContext.deleteCase`
  refuses, and `trg_cases_delete_role` blocks it in the database. Also
  **excluded**: no Opinions tab or "Ask Question" on a case
  (`ViewCase.tsx`, `canPostOpinions`/tab filter both exclude this role), and
  no meeting history tab or Start/Join Meeting button on an MTB
  (`MTBDetail.tsx`). Routes under `/sdc/*`.
- **MTB Expert** — reviewer-only: can view cases/MTBs and post opinions, but
  cannot create a case (no `/mtb-exp/my-cases` or case-creation routes exist
  at all), create an MTB, or add a case to one (`MTBs.tsx`/`MTBDetail.tsx`
  hide both controls; also blocked server-side, see below). Home is
  `/mtb-exp/mtbs`. Meeting-start is only **client-side** gated (the button
  stays disabled until a meeting is already active) — the real Start/Join
  action is a raw `window.open()` with no Supabase call to enforce against,
  so this is a UX nudge, not a security boundary; real enforcement would
  need a change to `jitsi-activation-backend` (out of scope so far).

**Routing**: `RoleRoute` (`src/components/RoleRoute.tsx`, replaced the old
`ProtectedRoute`) wraps every protected route with an `allowedRoles` list
and redirects to `roleHomePath(role)` otherwise. Each page is registered up
to three times in `App.tsx` — bare, `/sdc/*`, `/mtb-exp/*` — pointing at the
same element; `useRolePrefix()` supplies the right prefix to every internal
`navigate()` call.

**Effective ownership**: `AuthContext` exposes `effectiveOwnerId` —
`linkedClinicianId` for an SDC, otherwise the signed-in user's own id — and
`CasesContext`'s `userId` is now this value, not the raw signed-in id, so an
SDC's case/MTB reads and writes attribute to the linked clinician. A
separate `ownUserId` (always the raw signed-in id) is kept for the two
places ownership is genuinely personal, not delegated: joining/leaving an
MTB by invite code (`mtb_members`) — an SDC's own membership must not
silently enroll the clinician too.

**Server-side enforcement**: RLS `RESTRICTIVE` policies back the two
UI-level restrictions that matter for data integrity — SDC cannot insert
into `case_opinions`/`case_questions`; MTB Expert cannot insert into `mtbs`
(create) or `mtb_cases` (add case to MTB) — even via a direct API call
bypassing the UI. Full policy detail: "Row Level Security" in
`docs/DATABASE_SCHEMA.md`.

**`effectiveOwnerId` has a database counterpart, and RLS policies must use
it.** Any policy written as `auth.uid() = owner_id` is wrong for an SDC,
because the actor (`auth.uid()`) and the owner (`effectiveOwnerId`) are
deliberately different accounts — such a policy rejects every SDC write and
hides the clinician's rows from them. Owner-scoped policies therefore compare
against `public.effective_owner_id()` (see `docs/DATABASE_SCHEMA.md`), which
returns the linked clinician for an SDC and the caller's own id otherwise.
Policies about *membership* or about *who is acting* correctly stay on
`auth.uid()` — the same `ownUserId` vs `effectiveOwnerId` split the client
makes. Getting this backwards is how the first version of these policies
silently broke MTB create/rename for coordinators.

## Case creation wizard (2 steps)

1. **`NewCaseStep1.tsx`** — a deliberately minimal "Case Details" block plus a
   full-width upload area. It collects exactly two fields: **Patient Name**
   (optional, defaults to "Anonymous") and **Cancer Type** (required, one of
   the 418 types in `src/data/cancerTypes.json`, picked with the searchable
   `CancerTypeSelect` — search by name, abbreviation or body region; picking
   "Other Cancer Type (Not Listed)" adds a free-text box, and what's typed
   there is what the case stores). **There are no age or sex inputs** — those
   come from the uploaded documents, see "Patient age and sex are
   AI-extracted" below. The **case name is auto-generated** from the type's
   abbreviation plus 5 random digits (`ILC80981`; the abbreviation keeps its
   published form, so also `ccRCC80981` and `BR-PAGET80981`), checked against
   `cases.case_name` and regenerated on a collision. It is **never displayed
   on this screen and never user-editable**, here or later.
   Upload accepts png/jpg/jpeg/doc/docx/ppt/pptx/pdf/txt, by clicking the
   upload box or dragging files onto it (both go through the same checks);
   PDF page count is validated client-side via `pdfjs-dist` (max 50 pages) and
   duplicate filenames are rejected. Stores into `CaseCreationContext`
   (`step1Data`, `pendingFiles`) and advances to step 2. (During the
   walkthrough the upload box may instead receive the sample report, with an
   inline preview; see "Onboarding walkthrough" below.)
2. **`NewCaseStep2.tsx`** — free-text "case explanation" textarea, with
   optional voice dictation via the legacy `<VoiceRecorder>` component
   (appends transcribed text — see `docs/LEGACY_AND_KNOWN_ISSUES.md`, this
   component is intentionally untouched). The recorder sits in a labelled
   **Dictate** pill at the right end of the header (the `.dictate-control`
   wrapper in `src/index.css` styles it from outside); the character count is
   under the textarea. Its submit calls `useCreateCase().handleCreateCase`
   directly — there is no separate review step. That hook is the actual
   orchestrator of case creation + the document-AI pipeline handoff:
   1. **Blocks creation before any upload or API call** if there are zero
      clinical files *and* the explanation is empty — the only hard
      requirement is at least one of the two; either alone is enough.
   2. `getUploadConfiguration()` POSTs to `.../dev/get-upload-urls` to obtain
      a `request_id` plus S3 presigned POST fields, then uploads each
      pending file directly to S3 via `FormData` POST (skipped entirely for
      a text-only case).
   3. Inserts the `cases` row (`CasesContext.createCase`, initial status
      `processing`) plus `case_documents` metadata. Unlike the old 3-step
      flow, this no longer inserts `case_questions` or shares to any MTB at
      creation time — "questions for experts" and MTB sharing now only
      happen after the case exists, from the case page (see "Settings tab"
      and "Add question" below).
   4. Navigates to `/my-cases` immediately, then **in the background**
      inserts `case_additional_documents` (the case explanation, if any) and
      starts the case's first pipeline run (`startInitialRun`/`startRun` in
      `src/services/pipelineService.ts`; falls back to the older untracked
      `.../dev/trigger-converter-files-to-png` call if a tracked run
      couldn't be created) — see `docs/DOCUMENT_AI_PIPELINE.md`.

   A case made only of the walkthrough's sample report skips all of this
   (upload, database, pipeline) and just opens `/sample-case`.

`ReviewCase.tsx` and the `/cases/review` route were removed when the wizard
collapsed from 3 steps to 2. `CaseCreationContext.tsx` still declares an
`s3Credentials` field that is **never actually populated** — harmless dead
state, not wired to anything.

## Patient age and sex are AI-extracted, never typed in

Age and sex are **derived from the uploaded clinical documents**, not
collected from the user. There is no age/sex input anywhere in case creation.

`VMTB-EXTRACT-SUMMARIZE-V2` obtains them in the same Bedrock call that writes
the summary, using **native structured outputs** (Converse
`outputConfig.textFormat`, type `json_schema`) — the model is constrained at
decode time to return `{summary, patient_age, patient_sex}`, rather than being
asked in prose to include them. The values land in `cases.patient_age` /
`cases.patient_sex`, and are written **only when extraction actually produced
a value**, so a null never overwrites something the owner corrected by hand.
Mechanism detail: `docs/DOCUMENT_AI_PIPELINE.md`.

Consequences visible in the UI:
- Both fields read **"Not detected"** (grey) until the pipeline supplies them,
  which is also what a case shows while it is still processing.
- The summary text itself **does not restate age or sex**. They are displayed
  once, in the case-details row at the top of the summary section, so the
  prompt forbids repeating them in the prose body.
- The owner can always override either value by editing the case; that is the
  intended correction path when extraction gets it wrong or finds nothing.

**`patient_name` is never extracted or modified by the pipeline under any
code path.** It is highly sensitive PII, it is not part of the output schema,
and no Lambda writes that column — the only source of a patient name is what
the owner typed. Treat this as a hard constraint when changing the prompt or
the schema, not a default that can be relaxed.

## Case listing / MTB pages

- **`MyCases.tsx`** — the current user's own cases (`cases` filtered by
  `owner_id`), with status badges (processing/unverified/verified/failed —
  `summary_status`), search/sort, and a 10s poll (`refreshProcessingCases`)
  while any case is still `processing`. The single sort dropdown beside search
  also has an "Archived cases" option, which switches the list via
  `?view=archived` (the profile menu's "Archived cases" item links there);
  picking a sort option returns to active cases. Unknown routes render
  `NotFound.tsx` (catch-all `*` route in `App.tsx`). Badge labels/colours and the status
  info tooltip (`StatusInfoIcon`, rendered in a portal so the table can't clip
  it) both come from `src/utils/summaryStatus.ts`. The patient column renders
  `{age}Y, {sex}` only when both are present and falls back to "Not detected"
  otherwise — age/sex are nullable now that they come from extraction, so
  every render site has to guard them or the columns visibly misalign.
- **`MTBs.tsx`** — MTBs the user owns or is a member of; create (generates a
  `join_code`) and join-by-code modals.
- **`MTBDetail.tsx`** — a single MTB's view: lists **every** case shared into
  that MTB (`mtb_cases`, then the `cases` rows) regardless of `summary_status`,
  so a case whose owner has just changed its documents stays in the list
  instead of vanishing; a case that isn't verified shows an "Updating" /
  "awaiting verification" pill (`getMtbCaseStatusMeta` in
  `src/utils/summaryStatus.ts`) in place of the Reviewed / Not reviewed badge,
  and the list re-polls every 30 s while any listed case is unverified and
  whenever the window regains focus. The case count on `MTBs.tsx`
  (`mtb.cases`, built in `CasesContext.refetchMTBs`) counts those cases too.
  Only *adding* a case is verified-gated: the add-case modal
  offers owned, verified, non-archived cases not already in the MTB;
  rename/leave/notification-toggle; a "Meeting" modal (see below); and a real
  "Meeting History" section (`<MeetingsList>`, backed by `useMeetingHistory`)
  listing this MTB's `meeting_sessions`, each joined to its transcript/MoM
  status (`get_mtb_transcripts` RPC — none/pending/processing/completed/failed
  via `MomStatusBadge`), polling every 30s; a card links to
  `/mtb/:mtbId/meeting/:meetingId` (`MeetingDetail.tsx`) for the full minutes.
  Backend detail: `docs/MEETING_TRANSCRIPTION_PIPELINE.md`.

## Case viewing/collaboration — `ViewCase.tsx`

The single most complex page (five tabs): `summary`, `reports` (delegates to
`<Reports>` — the document-AI pipeline's output surface, see
`docs/DOCUMENT_AI_PIPELINE.md`), `opinions`, `treatmentfollowup` (delegates
to `<TreatmentPlanFollowUp>`), `settings`.

Key behaviors:

**One consolidated "case details + summary" section.** The summary tab renders
a single card, not separate patient-info and summary panels. Its header is one
line: the read-only field row on the left (Case, Patient, Age, Sex, Cancer
Type), all actions on the right. Each field has a fixed width and truncates
with an ellipsis plus a `title` tooltip, so a long case name or cancer type
can't reflow the row. There is no "Case Summary" heading, and **one** Edit
button puts the whole card — details and summary body together — into edit
mode. The Case field is system-generated and stays read-only even then.

- **Owner-only summary editing** — contentEditable rich text
  (`marked`/`turndown`/`DOMPurify` for markdown⇄HTML conversion). Edit-mode
  actions sit at the top of the card, not the bottom: Regenerate Summary,
  Save Changes, **Save & Verify**, Cancel. Regenerate appears *only* in edit
  mode — it is not part of the persistent toolbar.
- **Verification is gated on age/sex being present.** `handleVerifyClick`
  inspects `age`/`sex` and picks one of two `VerifyModal` modes: `blocked`
  ("Add patient details to verify" — explains they couldn't be detected from
  the documents, and its confirm button drops straight into edit mode), or
  `confirm` (a review/disclaimer step showing patient, age/sex and cancer
  type before committing). `Save & Verify` runs the same save path as Save
  Changes with an extra pre-check, so a missing field is reported inline
  ("Please fill in age and sex before verifying.") instead of saving and then
  being refused by the dialog.
- **Tabs lock until the case has been verified once, not on current status.**
  `summary_status` cycles back to `processing`/`unverified` on every later
  regeneration, so it can't answer "has this case ever passed verification".
  `cases.first_verified_at` does: it is stamped once by
  the `verify_case_summary` / `save_case_summary_edit` RPCs (via
  `CasesContext.verifySummary`/`saveSummaryEdit`) and never cleared. Reports/Opinions/Treatment/
  Settings render with a `Lock` icon and refuse selection only while it is
  null — a regeneration after the first verification does **not** re-lock
  them.
- **Regenerate Summary is capped at 5 per case, enforced server-side.** The
  button shows the remaining count and becomes a disabled "Regeneration limit
  reached (5/5)" chip at the cap. Enforcement is the `start_regeneration` RPC
  (`20260918_case_pipeline_runs.sql`), which also refuses while any update is
  already running (`RUN_IN_PROGRESS`). Document edits never count toward the
  cap, and an edit saved during a regeneration supersedes it and refunds it.
  (`increment_summary_regeneration_count` is no longer called by the app.)
- **Verify and summary saves are generation-checked.** `verify_case_summary`
  and `save_case_summary_edit` take the generation the page is showing and
  refuse while an update runs (`SUMMARY_NOT_READY`) or when the case changed
  since (`STALE_GENERATION`, e.g. a save from another tab), so a summary is
  never verified against content it wasn't generated from. The summary tab
  shows the shared `CaseUpdateStatus` strip (applying / failed + Retry /
  review and verify) — see "Edits and pipeline runs" in
  `docs/DOCUMENT_AI_PIPELINE.md`.
- **MTB members see the last verified version while the owner's changes are
  unverified.** When `verified_generation ≠ content_generation`, a non-owner
  sees `cases.verified_snapshot` (summary, age, sex, cancer type, "Your data")
  and the documents as of that generation, under a banner: "The owner has
  updated this case. The changes aren't verified yet…".
- **"You" badge is context-dependent** — it shows only when the owner is
  viewing through an MTB (`isOwner && fromMTB`), since it is meaningless on
  My Cases where every case is theirs.
- **Patient name is owner-only, enforced server-side.** `ViewCase.tsx`'s
  `showPatientName = isOwner || !fromMTB` is a UI nicety only, not the real
  control — it's a client-side, route-shape check that a bookmarked
  `/case/:id` link (no `?from=mtb`) could bypass. The actual enforcement is
  `cases_viewer_safe` (`docs/DATABASE_SCHEMA.md`), a Postgres view that nulls
  `patient_name` server-side unless the caller owns the case; every
  non-owner-reachable read (`CasesContext.getCaseById`/`fetchCaseRow`,
  `MTBDetail`'s shared-case list) goes through it instead of the raw `cases`
  table.
- Polls every 10s while `summaryStatus === 'processing'` to auto-refresh
  once the AI pipeline finishes.
- **MTB-scoped opinions** — when the case owner views the case, it discovers
  every MTB the case is shared into (`mtb_cases` join `mtbs`) and lets them
  filter opinions/questions per-MTB; non-owners only see the MTB context
  they arrived through (`?mtbId=` query param or the
  `/mtb/:mtbId/case/:id` route). Opinions, question answers, and replies all
  go through `CasesContext.addOpinion`, and replies inherit their parent's
  `mtb_id`.
- **Settings tab** (owner-only; non-owners see a notice) — three sections:
  - *MTB sharing*: lists every MTB the case is in, each with Remove
    (`removeCaseFromMTB`), plus "Add to MTBs", a multi-select of the user's
    MTBs (`addCaseToMTBs`, one batch insert — each `mtb_cases` row fires the
    member notification trigger). Adding requires `summary_status =
    'verified'` and a non-archived case, matching `MTBDetail`'s rule.
  - *Archive case* / *Restore case*: `archiveCase` calls the `archive_case`
    RPC, which sets `archived_at` **and removes the case from all MTBs**;
    restoring (`unarchiveCase`, also from the archived banner at the top of
    the page) does not re-share it. Archived cases appear under My Cases →
    Archived cases.
  - *Danger zone*: permanently delete (`CasesContext.deleteCase` manually
    cascades `case_opinions`/`case_questions`/`case_documents`/`mtb_cases`
    before deleting the `cases` row).
- "Add question" modal with an embedded `<VoiceRecorder>` for dictation.
  (Patient details are edited in the consolidated card described above, not
  in a separate modal.)

## Onboarding walkthrough

First-time users get a guided walkthrough (`components/onboarding/TourOverlay.tsx`,
steps and copy in `onboarding/steps.ts`, state in `context/OnboardingContext.tsx`).
It is shown once per account, on first use after signup; there is no way to
replay it. Accounts that existed before it shipped never see it.

**Role-aware since 2026-09-27** (see "Account roles" above): each
`TourGroup`/`TourStep` in `steps.ts` can carry an `allowedRoles` list
(undefined = every role); `OnboardingContext`'s group-picker and
`TourOverlay`'s step-skip both check it. Two milestone keys
(`case_flow`/`mtb_flow`, set only by finishing the case/MTB guided
sections) and the global "everything waits for welcome" gate are resolved
through `isKeySatisfied()`, which treats a key as satisfied for a role that
can never reach the one group that sets it — otherwise MTB Expert (no
case-creation route at all) would be permanently blocked from every later
group, including ones it can genuinely use (`mtbs`, `mtb_board`). The
"walkthrough is over" check (`applicableSavedKeys()`) is filtered to the
current role too, so a key no group ever sets for that role (e.g.
`opinions` for an SDC) doesn't keep the walkthrough "not finished" forever.
Per-role effect: MTB Expert only sees `welcome`→`mtbs`→`mtb_board` (every
case-creation/isOwner-gated group and step is `allowedRoles`-excluded); SDC
sees everything Clinician does except the `opinions` tip (inverted: this
group excludes SDC, not MTB Expert, since SDC is the one role that can't
post opinions). `SampleCase.tsx`'s Opinions tab and `SampleBoard.tsx`'s
Meeting button are now also role-filtered to match the real pages
(`ViewCase.tsx`/`MTBDetail.tsx`), so the guided tour doesn't show SDC a
control it doesn't actually have.

**Guided part**, in order:

1. **Welcome** (`/my-cases`): a welcome card, then My Cases, MTBs, and Add New
   Case, which the user clicks to go on.
2. **Case section**, hands-on, with a sample report:
   - Step 1 introduces patient name (optional), cancer type and the upload box.
     If the draft has no files, the tour **visibly drags and drops**
     `public/sample/sample-case-report.pdf` into the upload box
     (`SampleDropAnimation.tsx`; just a highlight under reduced motion). The file
     shows with a "Sample" badge and an inline preview. Cancer type is set to
     the sample's.
   - Step 2 introduces the explanation and the **Dictate** button (right end of
     the header; `VoiceRecorder` itself is unchanged); Review explains each section.
   - The user clicks Continue / Create Case themselves at each step.
   - `/sample-case` opens "In Progress" and turns "Pending" as soon as the user
     presses "Show it". The tour then covers checking and editing the summary and
     Verify, then one line per tab (Reports, Opinions, Treatment, Settings).
     "Continue to MTBs" or "Exit sample" ends the section.
   - If the user added their own files instead, the drop and the sample case are
     skipped: the tour only points at their real Create Case, and creating it
     ends the section.
3. **MTB section**: Create / Join on the MTBs page, then `/sample-board` (a look-alike board with
   **no meeting code at all**) for Add Case, the invite code and Meeting, and a
   final "Create a case" / "Done".

**Tips** (1–2 steps), shown the first time the user reaches something on a real
case or board, and only after the welcome:
- first Pending case on My Cases;
- reviewing and verifying their own case (skipped if they went through the sample);
- first open of Reports;
- the document viewer's View/Redact switch;
- the redaction tools;
- the Opinions tab;
- Treatment plan;
- case Settings;
- a real board.

How it works:
- Pages offer a group with `useTourGroup(id, ready)`; targets are
  `data-tour="…"` attributes. A group starts once its targets are on screen and
  no modal is open (the document viewer is marked `data-tour-host`, so its tips
  can show over it); missing targets are skipped.
- A click-absorbing layer covers the page. Most steps only point. "Act" steps
  leave a clickable hole over the highlighted control. Only controls in
  `ACT_TARGETS` (steps.ts) can be clicked through: Add New Case, the wizard's
  Continue buttons, the sample's Create Case and its Verify Case. None of them
  starts a meeting, touches a board, or creates a real case. "Run" steps' buttons
  do something themselves (`useTourAction`): drop the sample, mark the sample
  ready, or open the next screen.
- Saved on `profiles` (`onboarding_seen`, `onboarding_ended_at`): the welcome,
  the milestones `case_flow` and `mtb_flow`, and each tip. Guided steps inside a
  section are remembered for the session only, so an interrupted section (a
  refresh, leaving the wizard) restarts from its start. My Cases then shows a
  "Continue the tour" pointer. Browser Back to a finished wizard screen shows
  only its Continue step.
- In the guided part, X / Esc / "Skip tour" end the whole walkthrough. On a tip,
  X / Esc close that tip and "Turn off tips" ends everything. Other open tabs
  follow (BroadcastChannel) and re-read the profile when shown.
- Reads fail closed (no tour if the profile can't be read); a failed write is
  retried, then reported with a toast and replayed on the next load.
- **TEMPORARY (testing):** a profile with `onboarding_test_restart = true` gets
  the walkthrough from the start on every new login (not on refresh). The reset
  is done by `onboarding_test_restart_if_new_sign_in()`, called at the top of
  `OnboardingContext.load()`. Remove that call and run the drop statements in
  `20260919_onboarding_test_restart.sql`.

### Sample case and sample board

The sample report is a fictional placeholder: replace
`public/sample/sample-case-report.pdf` together with the text in
`src/onboarding/sampleCase.ts`. A case made only from the sample is **never
uploaded, saved or processed**:

- `useCreateCase.ts` sees that every pending file is the sample
  (`PendingFile.isSample`, `isSampleCase`). On Create it skips presign, S3,
  `createCase` and the pipeline start entirely. It puts the details in
  `CaseCreationContext.sampleDemo` (memory only) and opens `/sample-case`.
- `/sample-case` (`pages/SampleCase.tsx`) is local-only: status, summary edits,
  Verify, opinions (the mic uses the real dictation API) and a static treatment
  plan and settings. Refreshing or leaving discards it.
- Sample and real files can't be mixed: adding a real file removes the sample.
  The sample is only ever dropped into an empty draft. There is no "use sample"
  button outside the walkthrough.
- `/sample-board` (`pages/SampleBoard.tsx`) only opens while the MTB section is
  running. Its buttons show a toast, and it imports no meeting code.

## Meeting launch — two code paths, only one wired up

`MTBDetail.tsx`'s "Meeting" modal's actual "Start Meeting" button
`window.open()`s `${VITE_SERVER_LOADER_URL}?room=...&mtb_id=...&mtb_name=...`
(default `https://server.vmtb.in`) directly — this is the real, live
meeting-launch path.

`main/src/services/meeting.ts` (`MeetingService`, a
`WAITING → FIRST_READY → OPENED` polling state machine against
`jitsi-activation-backend`'s `/start-jitsi`) is also instantiated in
`MTBDetail.tsx` (`meetingServiceRef`), but **nothing in the UI actually calls
`meetingServiceRef.current.startMeeting()`**. This looks like a superseded
code path relative to the server-loader-based launch actually wired to the
button — flagged in `docs/LEGACY_AND_KNOWN_ISSUES.md`, not removed as part of
this doc pass.

## `case_treatment_plans` / `case_treatment_followups` vs. `case_follow_ups`

Two distinct, non-overlapping follow-up mechanisms exist on a case — don't
conflate them:
- **`case_follow_ups`** — free-text notes, written via
  `CasesContext.addFollowUp`.
- **`case_treatment_plans`** + **`case_treatment_followups`** — the
  structured MTB treatment-plan record (consensus, evidence levels,
  implementation tracking) and its longitudinal follow-up entries, rendered
  by the `<TreatmentPlanFollowUp>` component under `ViewCase.tsx`'s
  `treatmentfollowup` tab.

Full column reference for every table mentioned here: `docs/DATABASE_SCHEMA.md`.
