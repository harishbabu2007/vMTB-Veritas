-- Rollback for 20261010_p1_rpc_and_view_hardening.sql.
--
-- Restores the previous default privileges, the previous _run_json() and
-- get_case_run_state() bodies, and the view / meeting-table grants, and
-- drops the two new RPCs. The verified_snapshot backfill is data, not access,
-- and is deliberately not undone.
--
-- Re-opens: run state to anyone holding a session id (and, for
-- get_case_run_state, to anon); writes through cases_viewer_safe; anon reads
-- of mtb_meeting_stats; anon deletes of meeting rows. Prefer fixing forward.

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon;

CREATE OR REPLACE FUNCTION public._run_json(r public.case_pipeline_runs, p_duplicate boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT to_jsonb(r) || jsonb_build_object('duplicate', p_duplicate);
$$;

CREATE OR REPLACE FUNCTION public.get_case_run_state(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
    v_superseded INTEGER;
BEGIN
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;
    IF v_case.id IS NULL OR NOT (
        v_case.owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                   WHERE mc.case_id = p_case_id AND mm.user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    PERFORM public._expire_stale_runs(p_case_id);
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;

    SELECT * INTO v_run FROM public.case_pipeline_runs
    WHERE case_id = p_case_id ORDER BY generation DESC LIMIT 1;

    SELECT count(*) INTO v_superseded FROM public.case_pipeline_runs
    WHERE case_id = p_case_id AND status = 'superseded'
      AND v_run.id IS NOT NULL AND finished_at >= v_run.created_at - interval '5 seconds';

    RETURN jsonb_build_object(
        'content_generation', v_case.content_generation,
        'summary_generation', v_case.summary_generation,
        'verified_generation', v_case.verified_generation,
        'summary_status', v_case.summary_status,
        'report_status', v_case.report_status,
        'archived_at', v_case.archived_at,
        'run', CASE WHEN v_run.id IS NULL THEN NULL ELSE to_jsonb(v_run) END,
        'replaced_runs', v_superseded
    );
END;
$$;

DROP FUNCTION IF EXISTS public.join_mtb_by_code(text);
DROP FUNCTION IF EXISTS public.restore_case(uuid);

GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cases_viewer_safe TO anon, authenticated;
GRANT SELECT ON public.cases_viewer_safe TO anon;

ALTER VIEW public.mtb_meeting_stats SET (security_invoker = false);
GRANT ALL ON public.mtb_meeting_stats TO anon, authenticated;

GRANT DELETE, TRUNCATE ON public.meeting_sessions TO anon, authenticated;
GRANT DELETE, TRUNCATE ON public.meeting_participants TO anon, authenticated;

COMMIT;
