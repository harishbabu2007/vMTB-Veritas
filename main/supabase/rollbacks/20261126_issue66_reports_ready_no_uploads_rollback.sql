-- Rollback for 20261126_issue66_reports_ready_no_uploads.sql
-- Restores the previous function bodies (report_status CASE branches back
-- to `ELSE report_status`, get_case_run_state without reports_pending).
-- The data repair is not reverted: setting report_status = 'verified' for
-- notes-only cases matches what the old code would have done had it run the
-- anonymize step, and reverting would re-break those cases' Reports tabs.
--
-- Bodies copied from their pre-fix sources:
--   start_initial_run, retry_case_run, commit_case_edits:
--       20260918_case_pipeline_runs.sql
--   get_case_run_state:
--       20261010_p1_rpc_and_view_hardening.sql

CREATE OR REPLACE FUNCTION public.start_initial_run(p_case_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
    v_files TEXT[];
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_run.id IS NOT NULL THEN
        RETURN public._run_json(v_run, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);
    IF v_case.content_generation <> 0 THEN
        RAISE EXCEPTION 'ALREADY_STARTED';
    END IF;

    SELECT coalesce(array_agg(file_name), '{}') INTO v_files
    FROM public.case_documents WHERE case_id = p_case_id AND deleted_at IS NULL;

    INSERT INTO public.case_pipeline_runs (
        id, case_id, generation, kind, status, has_uploads, upload_files,
        materialize_done, anonymize_done, summary_done, documents_added, created_by)
    VALUES (
        p_session_id, p_case_id, 1, 'initial', 'pending', cardinality(v_files) > 0, v_files,
        true, cardinality(v_files) = 0, false, cardinality(v_files), auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.case_documents SET added_generation = 1 WHERE case_id = p_case_id;
    UPDATE public.cases
    SET content_generation = 1, summary_status = 'processing',
        report_status = CASE WHEN cardinality(v_files) > 0 THEN 'not_ready' ELSE report_status END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;


CREATE OR REPLACE FUNCTION public.retry_case_run(p_case_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_failed public.case_pipeline_runs;
    v_run public.case_pipeline_runs;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_run.id IS NOT NULL THEN
        RETURN public._run_json(v_run, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);
    PERFORM public._expire_stale_runs(p_case_id);

    SELECT * INTO v_failed FROM public.case_pipeline_runs
    WHERE case_id = p_case_id ORDER BY generation DESC LIMIT 1;
    IF v_failed.id IS NULL OR v_failed.status <> 'failed' OR v_failed.generation <> v_case.content_generation THEN
        RAISE EXCEPTION 'NOTHING_TO_RETRY';
    END IF;

    INSERT INTO public.case_pipeline_runs (
        id, case_id, generation, kind, status, has_uploads, upload_files,
        materialize_done, anonymize_done, summary_done, created_by)
    VALUES (
        p_session_id, p_case_id, v_case.content_generation + 1, 'retry', 'pending',
        v_failed.has_uploads, v_failed.upload_files,
        false, NOT v_failed.has_uploads, false, auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.cases
    SET content_generation = v_run.generation,
        summary_status = 'processing',
        report_status = CASE WHEN v_failed.has_uploads THEN 'not_ready' ELSE report_status END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;
