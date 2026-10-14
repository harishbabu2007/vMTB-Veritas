-- ----------------------------------------------------------------------------
-- PR: Enable RLS on redaction tables and tighten grants (F1, F2, F10)
-- ----------------------------------------------------------------------------
-- This migration enables Row Level Security on the three redaction tables
-- that previously had it intentionally off. The SELECT policies defined in
-- 20260914_manual_redaction_editor.sql are now activated.
-- Grants are tightened: service_role retains full access (needed by system
-- Lambdas and other components), anon access is revoked, and authenticated
-- users access is governed by the RLS policies below.
-- ----------------------------------------------------------------------------
-- Enable RLS on case_document_redactions
ALTER TABLE public.case_document_redactions ENABLE ROW LEVEL SECURITY;
-- Enable RLS on case_document_versions
ALTER TABLE public.case_document_versions ENABLE ROW LEVEL SECURITY;
-- Enable RLS on case_document_retention
ALTER TABLE public.case_document_retention ENABLE ROW LEVEL SECURITY;

-- Revoke the overly broad grants from the previous migration
REVOKE ALL ON public.case_document_redactions FROM anon;
REVOKE ALL ON public.case_document_versions FROM anon;
REVOKE ALL ON public.case_document_retention FROM anon;
REVOKE ALL ON public.case_document_redactions FROM authenticated;
REVOKE ALL ON public.case_document_versions FROM authenticated;
REVOKE ALL ON public.case_document_retention FROM authenticated;

-- Tighten grants: service_role retains full access (system Lambdas)
GRANT ALL ON public.case_document_redactions TO service_role;
GRANT ALL ON public.case_document_versions TO service_role;
GRANT ALL ON public.case_document_retention TO service_role;

-- Authenticated users get SELECT access (governed by RLS policies)
GRANT SELECT ON public.case_document_redactions TO authenticated;
GRANT SELECT ON public.case_document_versions TO authenticated;
GRANT SELECT ON public.case_document_retention TO authenticated;

-- anon access fully revoked; RLS policies reference auth.uid() which
-- returns NULL for anon, so even if grants existed they would be denied
