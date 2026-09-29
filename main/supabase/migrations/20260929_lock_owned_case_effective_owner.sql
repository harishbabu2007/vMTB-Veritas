-- Site Data Coordinators cannot actually save document edits, despite the UI
-- showing them full edit controls.
--
-- Same actor-vs-owner mistake as 20260927_effective_owner_id_rls.sql and
-- 20260928_sdc_archive_not_delete.sql's archive_case() fix, one level deeper:
-- _lock_owned_case() -- the single shared ownership gate for commit_case_edits,
-- start_initial_run, start_regeneration, retry_case_run, verify_case_summary,
-- save_case_summary_edit, and the two functions in
-- 20260918_verified_snapshot_notes.sql -- compares owner_id against
-- auth.uid() directly. For a coordinator, auth.uid() is never the owner (the
-- owner is the clinician they act for), so every one of those RPCs raises
-- NOT_OWNER for them. Concretely: a coordinator opens Reports (isOwner is
-- true client-side, from effectiveOwnerId), redacts/uploads/removes a
-- document, hits save, and commit_case_edits throws NOT_OWNER -- surfaced
-- verbatim as "Only the case owner can change this case."
--
-- Fixing this one function fixes all 8 call sites at once, consistently.

CREATE OR REPLACE FUNCTION public._lock_owned_case(p_case_id UUID)
RETURNS public.cases
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
    END IF;
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id FOR UPDATE;
    IF v_case.id IS NULL OR v_case.owner_id IS DISTINCT FROM public.effective_owner_id() THEN
        RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = '42501';
    END IF;
    RETURN v_case;
END;
$$;
