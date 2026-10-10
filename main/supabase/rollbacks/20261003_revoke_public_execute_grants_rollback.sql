-- Rollback for 20261003_revoke_public_execute_grants.sql.
--
-- Restores the implicit PUBLIC execute grant on the RPCs this project's
-- migrations had left in place, and unpins search_path on the five
-- functions. Re-opens those RPCs to anyone holding the anon key, so use it
-- only to unblock something and re-apply straight after.
--
-- If the failure is specifically that a signed-in user can no longer call a
-- case RPC, prefer re-granting that one function to `authenticated` over
-- running this whole file -- `authenticated` is the intended audience and is
-- already granted above.

BEGIN;

GRANT EXECUTE ON FUNCTION public.ensure_meeting_transcript(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_meeting_transcript(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.archive_case(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_case_edits(UUID, UUID, JSONB, TEXT[], JSONB, JSONB, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_case_summary_edit(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_case_summary(UUID, BIGINT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_initial_run(UUID, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_regeneration(UUID, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_case_run(UUID, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_case_run_state(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mtb_transcripts(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_summary_regeneration_count(UUID) TO PUBLIC;

ALTER FUNCTION public.document_key(TEXT) RESET search_path;
ALTER FUNCTION public._run_json(public.case_pipeline_runs, BOOLEAN) RESET search_path;
ALTER FUNCTION public.update_updated_at_column() RESET search_path;

-- Section 4 of the migration: trigger functions and invoker-rights helpers.
GRANT EXECUTE ON FUNCTION public.enforce_case_delete_role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public._case_documents_set_document_name() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_owner_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_key(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_onboarding_seen(TEXT) TO PUBLIC;

-- These two exist only where the live-only objects do.
DO $$
BEGIN
    IF to_regprocedure('public.update_speech_transcription_updated_at()') IS NOT NULL THEN
        ALTER FUNCTION public.update_speech_transcription_updated_at() RESET search_path;
        GRANT EXECUTE ON FUNCTION public.update_speech_transcription_updated_at() TO PUBLIC;
    END IF;
    IF to_regprocedure('public.notify_opinion_added_webhook()') IS NOT NULL THEN
        ALTER FUNCTION public.notify_opinion_added_webhook() RESET search_path;
        GRANT EXECUTE ON FUNCTION public.notify_opinion_added_webhook() TO PUBLIC;
    END IF;
END $$;

COMMIT;
