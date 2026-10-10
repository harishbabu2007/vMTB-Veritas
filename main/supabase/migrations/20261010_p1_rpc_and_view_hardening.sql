-- ============================================================================
-- Pre-launch hardening, phase 1: RPC leaks, default privileges, views
-- ============================================================================
-- Additive and safe to apply while the current frontend is live: nothing here
-- removes an access path the app uses today. (The restrictive half of phase
-- 1 is 20261003_profiles_identity_server_owned.sql and
-- 20261003_profiles_scope_select.sql, which wait for the frontend deploy.
-- 20261003_revoke_public_execute_grants.sql removes no path the current
-- frontend uses, so it was applied together with this file.)
--
--   1. Default privileges: new functions no longer get EXECUTE for PUBLIC,
--      anon and authenticated; new tables and sequences are no longer
--      granted to anon. Every migration from here on grants explicitly.
--   2. _run_json(): the idempotency fast path of commit_case_edits,
--      start_regeneration, retry_case_run and start_initial_run returned an
--      existing run's JSON to anyone holding its session id -- before the
--      owner check. A duplicate is now returned only to the case's owner.
--   3. get_case_run_state(): its access test was NULL (not false) for a
--      caller with no session, so the IF fell through and returned any
--      case's run state to anon. It also missed Site Data Coordinators and
--      board owners, and handed members the full run row.
--   4. join_mtb_by_code() and restore_case(): server-side versions of the
--      two client paths that the RLS phase will close (joining reads mtbs by
--      join_code; restoring updates cases directly). Added now so the
--      frontend can switch to them before those reads/writes stop working.
--   5. Backfill verified_snapshot for cases verified before snapshots
--      existed, so the members-see-only-the-snapshot rule has content to show.
--   6. Views and meeting tables: cases_viewer_safe is an auto-updatable
--      owner-rights view, so its write grants were a way around any RLS on
--      cases; mtb_meeting_stats was readable by anon; and anon could delete
--      meeting rows (nothing in either app deletes them).
--
-- Rollback: ../rollbacks/20261010_p1_rpc_and_view_hardening_rollback.sql
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Default privileges for objects created later
-- ---------------------------------------------------------------------------
-- Supabase's defaults grant every new table to anon and authenticated, and
-- every new function to PUBLIC, anon and authenticated. That is how
-- SECURITY DEFINER functions ended up callable with the public anon key.
-- From now on a new function is callable only by the roles a migration
-- names, and a new table is invisible to anon until a migration says
-- otherwise. (authenticated keeps the table default: RLS policies are what
-- scope it.) Objects that already exist are unaffected by this statement.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anon;


-- ---------------------------------------------------------------------------
-- 2. _run_json(): duplicates are for the case owner only
-- ---------------------------------------------------------------------------
-- Every `_run_json(..., true)` call is an idempotency fast path ("this
-- session was already committed, here is its run"), and in three of the four
-- callers it runs before _lock_owned_case(). Checking ownership here covers
-- all four without restating their bodies. `false` calls come after the
-- owner lock and are unaffected. Same error as _lock_owned_case, so the
-- frontend's existing NOT_OWNER message applies.
CREATE OR REPLACE FUNCTION public._run_json(r public.case_pipeline_runs, p_duplicate boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
    IF p_duplicate AND NOT EXISTS (
        SELECT 1 FROM public.cases c
        WHERE c.id = r.case_id
          AND c.owner_id = public.effective_owner_id()
    ) THEN
        RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = '42501';
    END IF;
    RETURN to_jsonb(r) || jsonb_build_object('duplicate', p_duplicate);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._run_json(public.case_pipeline_runs, boolean) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. get_case_run_state(): close the NULL fall-through, include SDCs and
--    board owners, keep run details for owners
-- ---------------------------------------------------------------------------
-- Owner test is effective_owner_id() (the coordinator's linked clinician),
-- matching _lock_owned_case. Board owners are not stored in mtb_members, so
-- they need their own clause. coalesce(..., false) is the fix for the
-- anonymous fall-through: with no session the comparison is NULL, and
-- `IF ... OR NOT (NULL)` is not true, so the old version never raised.
--
-- Members still see the case's generations and statuses (the UI uses them
-- for "updating / awaiting verification"), but the run row itself -- its
-- upload file names, error text and creator -- is returned to owners only.
-- The app only asks for run state on the owner path (useCaseRunState is
-- passed an id only when isOwner).
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
    v_is_owner BOOLEAN;
    v_is_viewer BOOLEAN;
BEGIN
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;
    IF v_case.id IS NULL THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    v_is_owner := coalesce(v_case.owner_id = public.effective_owner_id(), false);
    v_is_viewer := v_is_owner
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc
                   JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                   WHERE mc.case_id = p_case_id AND mm.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc
                   JOIN public.mtbs m ON m.id = mc.mtb_id
                   WHERE mc.case_id = p_case_id
                     AND m.owner_id = public.effective_owner_id());
    IF NOT coalesce(v_is_viewer, false) THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    PERFORM public._expire_stale_runs(p_case_id);
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;

    SELECT * INTO v_run FROM public.case_pipeline_runs
    WHERE case_id = p_case_id ORDER BY generation DESC LIMIT 1;

    -- How many earlier runs the latest one replaced mid-flight (for "your
    -- newer changes replace the update in progress").
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
        'run', CASE WHEN v_run.id IS NULL OR NOT v_is_owner THEN NULL ELSE to_jsonb(v_run) END,
        'replaced_runs', CASE WHEN v_is_owner THEN v_superseded ELSE 0 END
    );
END;
$$;


-- ---------------------------------------------------------------------------
-- 4a. join_mtb_by_code(): join a board without reading mtbs by join code
-- ---------------------------------------------------------------------------
-- Mirrors CasesContext.joinMTB: an unknown code fails; you cannot join a
-- board you (or, for a coordinator, your linked clinician) own; membership
-- is personal, so it is recorded for auth.uid(), never for the effective
-- owner. Joining twice is not an error.
CREATE OR REPLACE FUNCTION public.join_mtb_by_code(p_join_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_mtb public.mtbs;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_mtb FROM public.mtbs WHERE join_code = btrim(coalesce(p_join_code, ''));
    IF v_mtb.id IS NULL THEN
        RAISE EXCEPTION 'INVALID_JOIN_CODE';
    END IF;
    IF v_mtb.owner_id IS NOT DISTINCT FROM public.effective_owner_id() THEN
        RAISE EXCEPTION 'OWN_MTB';
    END IF;

    INSERT INTO public.mtb_members (mtb_id, user_id)
    VALUES (v_mtb.id, auth.uid())
    ON CONFLICT (mtb_id, user_id) DO NOTHING;

    RETURN v_mtb.id;
END;
$$;

COMMENT ON FUNCTION public.join_mtb_by_code(text) IS
    'Adds the caller to the board whose join_code matches. Replaces the browser reading mtbs by join_code and inserting into mtb_members, which the RLS phase closes.';

REVOKE EXECUTE ON FUNCTION public.join_mtb_by_code(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.join_mtb_by_code(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- 4b. restore_case(): the counterpart of archive_case()
-- ---------------------------------------------------------------------------
-- Same owner rule as archive_case (effective_owner_id(), so a coordinator
-- can restore their clinician's case), and like it, restoring does not
-- re-share the case with any board. Returns the restored row, or no rows if
-- nothing matched -- which the caller must treat as a failure.
CREATE OR REPLACE FUNCTION public.restore_case(p_case_id uuid)
RETURNS SETOF public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    UPDATE public.cases
    SET archived_at = NULL
    WHERE id = p_case_id
      AND owner_id = public.effective_owner_id()
      AND archived_at IS NOT NULL
    RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.restore_case(uuid) IS
    'Un-archives the caller''s own (or their linked clinician''s) case. Replaces the browser''s direct UPDATE of cases.archived_at, which the RLS phase closes.';

REVOKE EXECUTE ON FUNCTION public.restore_case(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.restore_case(uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. Backfill verified_snapshot for cases verified before it existed
-- ---------------------------------------------------------------------------
-- verify_case_summary has written the snapshot since 20260918; a case
-- verified earlier has none, and members will soon see only the snapshot.
-- Only cases whose current content is the verified content qualify
-- (summary_status = 'verified'): snapshotting anything else would publish
-- unverified text to members. verified_at keeps the original verification
-- time. On 2026-10-10 this matches exactly one case.
UPDATE public.cases c
SET verified_snapshot = jsonb_build_object(
        'summary', c.summary,
        'patient_age', c.patient_age,
        'patient_sex', c.patient_sex,
        'cancer_type', c.cancer_type,
        'notes', (SELECT jsonb_build_object('title', a.document_title, 'content', a.document_data)
                  FROM public.case_additional_documents a WHERE a.case_id = c.id),
        'verified_at', c.first_verified_at),
    verified_generation = coalesce(c.verified_generation, c.content_generation)
WHERE c.first_verified_at IS NOT NULL
  AND c.verified_snapshot IS NULL
  AND c.summary_status = 'verified';


-- ---------------------------------------------------------------------------
-- 6. Views and meeting tables
-- ---------------------------------------------------------------------------
-- cases_viewer_safe runs with its owner's rights and is auto-updatable, so a
-- write through it would bypass RLS on cases entirely. The app only ever
-- SELECTs it, and only when signed in. (Its row filter and masking change
-- with the RLS phase.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cases_viewer_safe FROM anon, authenticated;
REVOKE SELECT ON public.cases_viewer_safe FROM anon;
GRANT  SELECT ON public.cases_viewer_safe TO authenticated;

-- Aggregates over meeting_sessions; no app code reads it. Run it with the
-- caller's rights so it follows meeting_sessions' own access rules.
ALTER VIEW public.mtb_meeting_stats SET (security_invoker = true);
REVOKE ALL ON public.mtb_meeting_stats FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.mtb_meeting_stats FROM authenticated;
GRANT  SELECT ON public.mtb_meeting_stats TO authenticated;

-- Neither the main app nor jitsi-frontend deletes meeting rows; anon could.
REVOKE DELETE, TRUNCATE ON public.meeting_sessions FROM anon, authenticated;
REVOKE DELETE, TRUNCATE ON public.meeting_participants FROM anon, authenticated;
