-- ============================================================================
-- Lock meeting_participants writes to the server
-- ============================================================================
-- !! DO NOT APPLY THIS UNTIL THE NEW jitsi-frontend IS DEPLOYED !!
--
-- meeting_participants currently accepts inserts and updates from anyone
-- holding the anon key ("Service can insert/update meeting participants",
-- WITH CHECK (true), from MEETING_ANALYTICS_SCHEMA.sql). That was necessary
-- while jitsi-frontend -- which has no login -- wrote participant rows itself.
--
-- Once jitsi-frontend routes its writes through the meeting_participant_identity
-- Edge Function, nothing legitimate writes this table with the anon key any
-- more, and leaving the policies open would let anyone forge or overwrite a
-- speaker attribution after the fact -- which would defeat the whole point of
-- verifying it on the way in.
--
-- Applying this while the OLD jitsi-frontend is still live will silently stop
-- participant rows being recorded, which degrades every transcript to
-- "Speaker N". Deploy order: migration 20261001_meeting_participant_identity
-- -> Edge Function -> main app -> jitsi-frontend -> THIS migration.
--
-- meeting_sessions is deliberately left alone: jitsi-frontend still owns
-- session creation and the heartbeat, and the transcript-worker's VM-stop
-- guard depends on it.
-- ============================================================================

DROP POLICY IF EXISTS "Service can insert meeting participants" ON public.meeting_participants;
DROP POLICY IF EXISTS "Service can update meeting participants" ON public.meeting_participants;

-- The SELECT policy ("Users can view meeting participants for their MTBs") is
-- intentionally left in place -- reads are already scoped to the caller's MTBs.
-- service_role bypasses RLS entirely, so the Edge Function needs no policy.

COMMENT ON TABLE public.meeting_participants IS
    'One row per participant join. Written server-side only, by the meeting_participant_identity Edge Function, which verifies a join ticket before recording user_id/verified_name/verified_profession. display_name records what the participant chose to show and is NOT trusted for attribution.';
