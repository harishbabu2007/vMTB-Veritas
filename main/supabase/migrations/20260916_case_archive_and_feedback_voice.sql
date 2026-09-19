-- Case archiving + voice input for the feedback form.
--
-- archived_at: set when the owner archives a case from Case Settings, cleared
-- on restore. Archiving also removes the case from every MTB (mtb_cases rows
-- are deleted); restoring does NOT re-share it -- the owner adds it to MTBs
-- again, which fires the normal case_created_notification trigger.

ALTER TABLE public.cases
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.cases.archived_at IS
    'Set when the owner archives the case (archive_case()); NULL for active cases. Archived cases are hidden from My Cases (shown under Archived cases) and have had all their mtb_cases links removed.';

CREATE INDEX IF NOT EXISTS cases_owner_archived_idx
    ON public.cases (owner_id, archived_at);

-- Archive a case and remove it from every MTB in one transaction, only for
-- the caller's own, not-yet-archived case. Returns the updated row, or no
-- rows if nothing was archived (not found, not owned, already archived).
CREATE OR REPLACE FUNCTION public.archive_case(p_case_id UUID)
RETURNS SETOF public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
BEGIN
    UPDATE public.cases
    SET archived_at = now()
    WHERE id = p_case_id
      AND owner_id = auth.uid()
      AND archived_at IS NULL
    RETURNING * INTO v_case;

    IF v_case.id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM public.mtb_cases WHERE case_id = p_case_id;

    RETURN NEXT v_case;
END;
$$;

GRANT EXECUTE ON FUNCTION public.archive_case(UUID) TO authenticated;

-- Allow 'feedback' as a voice-dictation source (Send Feedback modal).
-- speech_transcriptions exists only in the live database (not in the tracked
-- baseline migration), so guard on its existence.
DO $$
BEGIN
    IF to_regclass('public.speech_transcriptions') IS NOT NULL THEN
        ALTER TABLE public.speech_transcriptions
            DROP CONSTRAINT IF EXISTS speech_transcriptions_source_check;
        ALTER TABLE public.speech_transcriptions
            ADD CONSTRAINT speech_transcriptions_source_check
            CHECK (source = ANY (ARRAY['step2', 'general_opinion', 'question', 'answer', 'reply', 'feedback']));
    END IF;
END;
$$;
