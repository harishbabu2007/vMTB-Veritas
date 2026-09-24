-- ============================================================================
-- Fix MoM/transcript visibility in meeting history + detail.
--
-- Problem (verified live 2026-09-24):
--   * meeting_transcripts.mtb_id is always NULL (proxy never learns the MTB),
--     so get_mtb_transcripts (WHERE mtb_id = p_mtb_id) returned zero rows and
--     the UI always fell through to "No transcript available".
--   * meeting_transcripts.meeting_id is the opaque Jitsi conference UUID —
--     NOT meeting_sessions.id — so the frontend join on session.id never
--     matched even when rows existed.
--
-- Fix:
--   1. Auto-link mtb_id by matching an unlinked transcript's started_at
--      window against that MTB's meeting_sessions (the documented
--      reconciliation approach in docs/JITSI_TRANSCRIPTION_CONFIG.md §5).
--   2. Return session_id (best-matching meeting_sessions.id) so the frontend
--      can join without guessing.
--   3. Gate on MTB membership (auth.uid()) — the previous RPC leaked any
--      MTB's transcripts to any authenticated caller who guessed the UUID.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_mtb_transcripts(UUID);

CREATE FUNCTION public.get_mtb_transcripts(p_mtb_id UUID)
RETURNS TABLE (
    id                      UUID,
    meeting_id              TEXT,
    mtb_id                  UUID,
    status                  TEXT,
    transcript_object_key   TEXT,
    transcript_version      INTEGER,
    mom                     JSONB,
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    error_message           TEXT,
    created_at              TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ,
    session_id              UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Membership gate: only members of this MTB may read its transcripts.
    -- (Alias mm is required: an unqualified mtb_id is ambiguous with the
    -- mtb_id OUT parameter from RETURNS TABLE.)
    IF NOT EXISTS (
        SELECT 1 FROM public.mtb_members mm
        WHERE mm.mtb_id = p_mtb_id AND mm.user_id = auth.uid()
    ) THEN
        RETURN;
    END IF;

    -- Auto-link unlinked transcripts to this MTB via a time-window match.
    -- Transcript rows are created by the proxy with only the Jitsi conference
    -- id; meeting_sessions carry mtb_id + room_name. A transcript that started
    -- during (or shortly around) a session for this MTB belongs to that MTB.
    UPDATE public.meeting_transcripts t
    SET mtb_id = p_mtb_id,
        updated_at = now()
    FROM (
        SELECT DISTINCT ON (t2.id) t2.id AS transcript_id
        FROM public.meeting_transcripts t2
        JOIN public.meeting_sessions ms
          ON ms.mtb_id = p_mtb_id
         AND t2.started_at IS NOT NULL
         AND t2.started_at >= ms.started_at - INTERVAL '5 minutes'
         AND (
                ms.ended_at IS NULL
                OR t2.started_at <= ms.ended_at + INTERVAL '60 minutes'
         )
        WHERE t2.mtb_id IS NULL
        ORDER BY t2.id, abs(EXTRACT(EPOCH FROM (ms.started_at - t2.started_at)))
    ) m
    WHERE t.id = m.transcript_id
      AND t.mtb_id IS NULL;

    -- Now every row for this MTB has mtb_id set (either already or just linked).
    -- Attach the best-matching session id for the frontend join.
    RETURN QUERY
    SELECT
        t.id,
        t.meeting_id,
        t.mtb_id,
        t.status,
        t.transcript_object_key,
        t.transcript_version,
        t.mom,
        t.started_at,
        t.completed_at,
        t.error_message,
        t.created_at,
        t.updated_at,
        ms.id AS session_id
    FROM public.meeting_transcripts t
    LEFT JOIN LATERAL (
        SELECT ms2.id
        FROM public.meeting_sessions ms2
        WHERE ms2.mtb_id = p_mtb_id
          AND t.started_at IS NOT NULL
          AND t.started_at >= ms2.started_at - INTERVAL '5 minutes'
          AND (
                ms2.ended_at IS NULL
                OR t.started_at <= ms2.ended_at + INTERVAL '60 minutes'
          )
        ORDER BY abs(EXTRACT(EPOCH FROM (ms2.started_at - t.started_at)))
        LIMIT 1
    ) ms ON TRUE
    WHERE t.mtb_id = p_mtb_id
    ORDER BY t.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mtb_transcripts(UUID) TO authenticated;
