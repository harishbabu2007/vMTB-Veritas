-- patient_name is sensitive PII that must only ever be visible to a case's
-- owner. `cases` has RLS disabled (see docs/DATABASE_SCHEMA.md's "Row Level
-- Security" section -- a larger, separately-tracked concern; not something
-- this migration attempts to fix), so today every read of `cases` -- direct
-- table queries from the app, and any raw REST/anon call -- returns
-- patient_name unfiltered to whoever asks, regardless of ownership.
--
-- This migration does not touch RLS or grants on the base table (that
-- remains open, tracked separately). It adds a narrow, additive view that
-- the app's own read paths are switched to use instead of the raw table
-- wherever a viewer might not be the case's owner: it returns every `cases`
-- column unchanged except patient_name, which is nulled out unless the
-- caller (auth.uid()) is the case's owner_id.
--
-- This closes the concrete bug: a non-owner reaching a case via any route
-- shape (a bookmarked/pasted /case/:id link with no ?from=mtb, browser
-- history, or the normal MTB case list) no longer receives patient_name in
-- the network response at all -- not just hidden by a client-side check.
create or replace view public.cases_viewer_safe
with (security_invoker = false)
as
select
  c.id,
  c.owner_id,
  c.case_name,
  case when c.owner_id = auth.uid() then c.patient_name else null end as patient_name,
  c.patient_age,
  c.patient_sex,
  c.cancer_type,
  c.summary,
  c.treatment_plan,
  c.created_at,
  c.summary_status,
  c.request_id,
  c.report_status,
  c.ai_generated_summary,
  c.first_verified_at,
  c.summary_regeneration_count,
  c.archived_at,
  c.content_generation,
  c.summary_generation,
  c.verified_generation,
  c.verified_snapshot
from public.cases c;

comment on view public.cases_viewer_safe is
  'Read-only, column-redacted view of cases: patient_name is nulled unless the caller owns the case. Used by every app read path that may be reading a case the caller does not own (CasesContext.getCaseById/fetchCaseRow, MTBDetail''s shared-case list). Not a substitute for enabling RLS on cases -- see docs/DATABASE_SCHEMA.md.';

grant select on public.cases_viewer_safe to authenticated;
