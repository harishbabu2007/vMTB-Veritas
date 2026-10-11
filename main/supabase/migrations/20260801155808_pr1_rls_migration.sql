-- ----------------------------------------------------------------------------
-- PR1: Enable Row Level Security on redaction tables and tighten grants
-- ----------------------------------------------------------------------------
-- This migration enables RLS on the three redaction tables that previously
-- had it intentionally off (see 20260914_manual_redaction_editor.sql header).
-- The SELECT policies defined in that migration (case_document_redactions,
-- case_document_versions, case_document_retention) are now activated.
-- Grants are tightened: service_role retains full access (needed by Lambdas
-- that write directly), while anon and authenticated gain access only through
-- the RLS policies below.
-- ----------------------------------------------------------------------------
-- Enable RLS on case_document_redactions
ALTER TABLE public.case_document_redactions ENABLE ROW LEVEL SECURITY;
-- Enable RLS on case_document_versions
ALTER TABLE public.case_document_versions ENABLE ROW LEVEL SECURITY;
-- Enable RLS on case_document_retention
ALTER TABLE public.case_document_retention ENABLE ROW LEVEL SECURITY;

-- Tighten grants: service_role retains full access (Lambdas write directly)
GRANT ALL ON public.case_document_redactions TO service_role;
GRANT ALL ON public.case_document_versions TO service_role;
GRANT ALL ON public.case_document_retention TO service_role;

-- Authenticated users get SELECT access so RLS policies can evaluate
GRANT SELECT ON public.case_document_redactions TO authenticated;
GRANT SELECT ON public.case_document_versions TO authenticated;
GRANT SELECT ON public.case_document_retention TO authenticated;

-- anon access revoked: RLS policies reference auth.uid(), denying anon
