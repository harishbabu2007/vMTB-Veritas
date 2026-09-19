-- ============================================================================
-- RPCs for meeting history and MoM display in the main app.
--
-- get_mtb_transcripts(p_mtb_id)
--   Returns all meeting_transcripts rows for a given MTB. Used by the main
--   app to display MoM status and content in the meetings tab.
--
-- link_transcript_to_mtb(p_meeting_id, p_mtb_id)
--   Sets mtb_id on a meeting_transcripts row so the RLS SELECT policy
--   (mtb_id IS NOT NULL AND mtb_id IN mtb_members) allows authenticated
--   reads. Idempotent: no-op if the row already has the correct mtb_id.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. get_mtb_transcripts — fetch all transcripts for an MTB
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_mtb_transcripts(p_mtb_id UUID)
RETURNS SETOF public.meeting_transcripts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT *
    FROM public.meeting_transcripts
    WHERE mtb_id = p_mtb_id
    ORDER BY created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_mtb_transcripts(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. link_transcript_to_mtb — set mtb_id on an existing transcript row
-- ----------------------------------------------------------------------------
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

GRANT EXECUTE ON FUNCTION public.link_transcript_to_mtb(TEXT, UUID) TO authenticated;
