-- ============================================================================
-- Verified speaker identity for meeting transcripts
-- ============================================================================
-- Problem this solves
-- -------------------
-- A transcript line's speaker name comes from meeting_participants.display_name,
-- which jitsi-frontend writes using the Jitsi prejoin display name. That name is
-- (a) assembled client-side from ?name=/?role= URL params, (b) freely editable in
-- the prejoin box, and (c) written with the anon key by a page that has no login
-- at all. So the speaker label on a clinical transcript is a self-asserted string
-- with no link to any account, and the medical profession exists only as text
-- inside it ("Priya Sharma (Medical oncologist)") rather than as data.
--
-- The fix is a join ticket. The authenticated app mints an opaque token bound to
-- auth.uid(); that token travels on the meeting URL in place of the name/role;
-- and an Edge Function (service role) exchanges it for the real user, reads
-- name + profession from profiles, and writes the participant row itself. The
-- browser never asserts an identity -- it only presents a ticket it could not
-- have forged. The prejoin box stays editable; it just stops being trusted.
--
-- This migration is ADDITIVE ONLY and is safe to apply before jitsi-frontend
-- ships. The companion migration 20261001_lock_meeting_participants_writes.sql
-- removes the permissive write policies and MUST NOT be applied until the new
-- jitsi-frontend is deployed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. meeting_join_tickets -- opaque token -> verified user
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_join_tickets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token       TEXT NOT NULL UNIQUE,
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    mtb_id      UUID NOT NULL REFERENCES public.mtbs(id) ON DELETE CASCADE,
    room_name   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '2 hours',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_join_tickets_token
    ON public.meeting_join_tickets(token);
CREATE INDEX IF NOT EXISTS idx_meeting_join_tickets_expires_at
    ON public.meeting_join_tickets(expires_at);

-- RLS on with no policies = no access for anon/authenticated. The only readers
-- and writers are the SECURITY DEFINER function below and the Edge Function's
-- service-role client, both of which bypass RLS. A ticket must never be
-- readable by the browser: reading one would let a client enumerate the
-- user_id it maps to.
ALTER TABLE public.meeting_join_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meeting_join_tickets FROM anon, authenticated;

COMMENT ON TABLE public.meeting_join_tickets IS
    'Short-lived opaque tokens binding a Jitsi meeting join to an authenticated user. Minted by create_meeting_join_ticket(), redeemed by the meeting_participant_identity Edge Function.';

-- ----------------------------------------------------------------------------
-- 2. meeting_participants -- server-verified identity columns
-- ----------------------------------------------------------------------------
-- display_name is deliberately KEPT. It remains the record of what the person
-- chose to show on their video tile, which is still useful; the verified_*
-- columns are what the transcript is built from. Keeping both means the choice
-- of which to display can change later without a second migration.
ALTER TABLE public.meeting_participants
    ADD COLUMN IF NOT EXISTS user_id             UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS verified_name       TEXT,
    ADD COLUMN IF NOT EXISTS verified_profession TEXT,
    ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_meeting_participants_user_id
    ON public.meeting_participants(user_id);

COMMENT ON COLUMN public.meeting_participants.user_id IS
    'Verified account behind this Jitsi participant. NULL means the join was never bound to a ticket -- transcript-worker must label these as unverified, never guess from display_name.';
COMMENT ON COLUMN public.meeting_participants.verified_profession IS
    'profiles.profession snapshotted at join time, written server-side. Snapshot (not a live lookup) so a later profile edit cannot rewrite the attribution on an existing clinical transcript.';

-- ----------------------------------------------------------------------------
-- 3. create_meeting_join_ticket -- the only place a ticket is minted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_meeting_join_ticket(
    p_mtb_id    UUID,
    p_room_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_token   TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Owner OR member. MTB owners are not stored in mtb_members (only
    -- join-code members are), so a members-only check would lock an owner out
    -- of their own board -- same gate as get_mtb_transcripts.
    IF NOT EXISTS (
        SELECT 1 FROM public.mtbs m
        WHERE m.id = p_mtb_id AND m.owner_id = v_user_id
    ) AND NOT EXISTS (
        SELECT 1 FROM public.mtb_members mm
        WHERE mm.mtb_id = p_mtb_id AND mm.user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'Not a member of this MTB';
    END IF;

    -- 64 hex chars / 256 bits from two gen_random_uuid() calls, which is
    -- built in on PG13+. Avoids depending on pgcrypto's gen_random_bytes
    -- being present in the search_path on this project.
    v_token := replace(gen_random_uuid()::text, '-', '')
            || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO public.meeting_join_tickets (token, user_id, mtb_id, room_name)
    VALUES (v_token, v_user_id, p_mtb_id, p_room_name);

    -- Opportunistic cleanup; tickets are worthless once expired.
    DELETE FROM public.meeting_join_tickets
    WHERE expires_at < now() - INTERVAL '1 day';

    RETURN v_token;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, which makes the function
-- reachable by the anon role via /rest/v1/rpc/. The auth.uid() guard above
-- makes an anonymous call fail safely, but it should not reach the body.
REVOKE EXECUTE ON FUNCTION public.create_meeting_join_ticket(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_meeting_join_ticket(UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. SECURITY FIX: link_transcript_to_mtb had no access check
-- ----------------------------------------------------------------------------
-- As defined in 20260918_meeting_rpcs.sql this is SECURITY DEFINER, performs no
-- auth.uid() check at all, and is granted to every authenticated user. Any
-- logged-in account could therefore rebind ANY meeting transcript to an MTB it
-- controls and then read that board's discussion through get_mtb_transcripts --
-- a cross-board clinical data leak. 20260924 fixed the read side and left this
-- write side untouched. Unrelated to the identity work above; fixed here
-- because it was found during it.
CREATE OR REPLACE FUNCTION public.link_transcript_to_mtb(
    p_meeting_id TEXT,
    p_mtb_id UUID
)
RETURNS public.meeting_transcripts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.meeting_transcripts;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.mtbs m
        WHERE m.id = p_mtb_id AND m.owner_id = auth.uid()
    ) AND NOT EXISTS (
        SELECT 1 FROM public.mtb_members mm
        WHERE mm.mtb_id = p_mtb_id AND mm.user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Not a member of this MTB';
    END IF;

    -- Refuse to steal a transcript that is already linked elsewhere. Without
    -- this, membership of any one board would still be enough to pull another
    -- board's transcript across.
    IF EXISTS (
        SELECT 1 FROM public.meeting_transcripts t
        WHERE t.meeting_id = p_meeting_id
          AND t.mtb_id IS NOT NULL
          AND t.mtb_id <> p_mtb_id
    ) THEN
        RAISE EXCEPTION 'Transcript is already linked to a different MTB';
    END IF;

    UPDATE public.meeting_transcripts
    SET mtb_id = p_mtb_id,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND (mtb_id IS NULL OR mtb_id != p_mtb_id)
    RETURNING * INTO v_row;

    IF v_row IS NULL THEN
        SELECT * INTO v_row FROM public.meeting_transcripts WHERE meeting_id = p_meeting_id;
    END IF;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.link_transcript_to_mtb(TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.link_transcript_to_mtb(TEXT, UUID) TO authenticated;
