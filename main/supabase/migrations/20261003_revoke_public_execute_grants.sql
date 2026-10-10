-- Close the default PUBLIC execute grant on the SECURITY DEFINER RPCs.
--
-- Why
-- ---
-- `GRANT EXECUTE ... TO service_role` does not stop anyone else calling a
-- function. Postgres gives every new function an implicit EXECUTE grant to
-- PUBLIC, and nothing here ever revoked it -- so the ACLs read
-- `{=X/postgres,postgres=X/postgres,...}`, where that leading `=X` is PUBLIC,
-- and `anon` inherits it. Every one of these is reachable over
-- `/rest/v1/rpc/<name>` with the anon key that ships in the frontend bundle.
--
-- Two groups:
--
-- 1. The meeting-transcript state machine. These were granted to
--    `service_role` only (20260820_meeting_transcripts.sql:254-257) and are
--    called by transcript-worker and opus-transcriber-proxy, which hold the
--    service-role key. Nothing else should reach them --
--    `complete_meeting_transcript` writes `mom`, the generated
--    minutes-of-meeting, straight from its argument.
--
-- 2. The owner-facing case RPCs. These do check ownership internally (via
--    `_lock_owned_case()` or `effective_owner_id()`), and `auth.uid()` is
--    NULL for an anon caller, so those checks already fail. Revoking PUBLIC
--    turns that from "the function declines" into "the function cannot be
--    called", which is where an authorisation boundary belongs.
--
-- This is the same fix already applied to `create_meeting_join_ticket` and
-- `link_transcript_to_mtb` in 20261001_meeting_participant_identity.sql; it
-- just was not applied to the rest.
--
-- NOT included: the `pipeline_*` functions. Those are granted to `anon`
-- deliberately, because the document Lambdas authenticate to Supabase with
-- the anon key (20260918_case_pipeline_runs.sql:994-999). Revoking them
-- requires moving those Lambdas onto a server key first (pre-launch plan
-- phases 4-5) -- doing it here would break the document pipeline.
--
-- Trigger functions (section 4) are revoked too. An RPC call to one fails
-- anyway ("trigger functions can only be called as triggers"), so this is
-- mostly about the advisor -- but it is also safe: Postgres checks EXECUTE on
-- a trigger function only at CREATE TRIGGER time, never when the trigger
-- fires. The P1 verification gate re-runs an owner case delete and the SDC
-- delete block to confirm `trg_cases_delete_role` still fires.
--
-- Two of the functions touched here exist only in the live database (no
-- tracked migration creates them): update_speech_transcription_updated_at()
-- and notify_opinion_added_webhook(). Their statements are guarded with
-- to_regprocedure() so this file also runs on a fresh database.
--
-- Rollback: 20261003_revoke_public_execute_grants_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Meeting transcript state machine -- service_role only
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.ensure_meeting_transcript(TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_meeting_transcript(TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ensure_meeting_transcript(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_meeting_transcript(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Owner-facing case RPCs -- signed-in callers only
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.archive_case(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.commit_case_edits(UUID, UUID, JSONB, TEXT[], JSONB, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.save_case_summary_edit(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.verify_case_summary(UUID, BIGINT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_initial_run(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_regeneration(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.retry_case_run(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_case_run_state(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_mtb_transcripts(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.increment_summary_regeneration_count(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.archive_case(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_case_edits(UUID, UUID, JSONB, TEXT[], JSONB, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_case_summary_edit(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_case_summary(UUID, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_initial_run(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_regeneration(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_case_run(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_case_run_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_mtb_transcripts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_summary_regeneration_count(UUID) TO authenticated;

-- `increment_summary_regeneration_count` is superseded by
-- `start_regeneration` and has no caller left in the app
-- (docs/LEGACY_AND_KNOWN_ISSUES.md). It is locked down rather than dropped
-- here so this migration stays grants-only; dropping it belongs with the
-- dead-code pass.

-- ---------------------------------------------------------------------------
-- 3. Pin search_path on the five functions that leave it mutable
-- ---------------------------------------------------------------------------
-- A function without an explicit search_path resolves unqualified names
-- using the caller's, so whoever calls it decides which schema its
-- references point at. Every other function in this schema already sets
-- `search_path = public`; these five were missed. ALTER is enough -- no need
-- to restate the bodies.
ALTER FUNCTION public.document_key(TEXT) SET search_path = public;
ALTER FUNCTION public._run_json(public.case_pipeline_runs, BOOLEAN) SET search_path = public;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;

DO $$
BEGIN
    IF to_regprocedure('public.update_speech_transcription_updated_at()') IS NOT NULL THEN
        ALTER FUNCTION public.update_speech_transcription_updated_at() SET search_path = public;
    END IF;
    -- Calls net.http_post, which is already schema-qualified in the body.
    IF to_regprocedure('public.notify_opinion_added_webhook()') IS NOT NULL THEN
        ALTER FUNCTION public.notify_opinion_added_webhook() SET search_path = public;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Trigger functions and invoker-rights helpers -- nobody calls these over
--    the API
-- ---------------------------------------------------------------------------
-- Trigger functions: no role needs EXECUTE for a trigger to fire (see above).
REVOKE EXECUTE ON FUNCTION public.enforce_case_delete_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._case_documents_set_document_name() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF to_regprocedure('public.update_speech_transcription_updated_at()') IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION public.update_speech_transcription_updated_at() FROM PUBLIC, anon, authenticated;
    END IF;
    IF to_regprocedure('public.notify_opinion_added_webhook()') IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION public.notify_opinion_added_webhook() FROM PUBLIC, anon, authenticated;
    END IF;
END $$;

-- Invoker-rights helpers. They run with the caller's own rights, so they
-- expose nothing new, but anon has no use for them either. authenticated
-- keeps EXECUTE because it genuinely needs it:
--   * effective_owner_id() -- inside the mtbs/mtb_cases/case_opinions/
--     case_questions policies, evaluated as the signed-in caller;
--   * document_key() -- called by the case_documents BEFORE INSERT trigger,
--     which runs as the inserting user (case creation);
--   * mark_onboarding_seen() -- the onboarding tour.
REVOKE EXECUTE ON FUNCTION public.effective_owner_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.document_key(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mark_onboarding_seen(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.effective_owner_id() TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.document_key(TEXT) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.mark_onboarding_seen(TEXT) TO authenticated;
