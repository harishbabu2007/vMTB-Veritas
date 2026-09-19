-- DEFERRED — see ../migrations_deferred/README.md before applying this.
--
-- Locks down case_document_redactions / case_document_versions /
-- case_document_retention (added in
-- ../migrations/20260914_manual_redaction_editor.sql) to match the
-- security posture originally designed for them: RLS on, writes restricted
-- to the service role only, so the browser (which authenticates with the
-- anon key, same as every Supabase call in main/) can never write directly
-- to these tables and bypass the Lambda-driven S3 regeneration that's
-- supposed to always accompany a change here.
--
-- PREREQUISITE, do this first or the two writing Lambdas will start
-- failing the moment this is applied:
--   1. Pull the `service_role` key from Supabase → Project Settings → API.
--   2. Set it as SUPABASE_SERVICE_ROLE_KEY on VMTB-OCR2ANO-V2 and
--      VMTB-APPLY-REDACTION-CHANGES-V2.
--   3. In both Lambdas' redaction_core.py call sites, switch the client
--      passed into insert_redaction_records / apply_redaction_changes /
--      insert_version_record / upsert_originals_retention /
--      archive_current_version_and_get_next_number from the existing
--      anon-key `supabase` client to a new service-role client.
--
-- To apply: copy this file into ../migrations/ with a fresh YYYYMMDD_
-- prefix, then run it the normal way. Don't just rename it in place —
-- it needs to sort after every migration already applied by then.

ALTER TABLE public.case_document_redactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_document_retention ENABLE ROW LEVEL SECURITY;
-- Added by ../migrations/20260918_case_pipeline_runs.sql, same model.
ALTER TABLE public.case_pipeline_runs ENABLE ROW LEVEL SECURITY;

-- The SELECT policies from the original migration are already in place and
-- become active the moment RLS is enabled — nothing to redefine here.

-- Revoke the blanket grants the original migration gave anon/authenticated,
-- replace with SELECT-only for those two roles; service_role keeps full
-- access (RLS doesn't apply to it, but keeping the explicit grant matches
-- this schema's newest-migration convention of being explicit rather than
-- relying only on the default service_role bypass).
REVOKE ALL ON public.case_document_redactions FROM anon, authenticated;
REVOKE ALL ON public.case_document_versions FROM anon, authenticated;
REVOKE ALL ON public.case_document_retention FROM anon, authenticated;
REVOKE ALL ON public.case_pipeline_runs FROM anon, authenticated;

GRANT SELECT ON public.case_document_redactions TO anon, authenticated;
GRANT SELECT ON public.case_document_versions TO anon, authenticated;
GRANT SELECT ON public.case_document_retention TO anon, authenticated;
GRANT SELECT ON public.case_pipeline_runs TO anon, authenticated;

GRANT ALL ON public.case_document_redactions TO service_role;
GRANT ALL ON public.case_document_versions TO service_role;
GRANT ALL ON public.case_document_retention TO service_role;
GRANT ALL ON public.case_pipeline_runs TO service_role;
