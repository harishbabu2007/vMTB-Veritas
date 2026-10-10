-- ============================================================================
-- Capture speech_transcriptions, which until now existed only in the live
-- database
-- ============================================================================
-- The legacy voice-dictation table was created directly against the live
-- project and never committed, so `supabase db reset` (or a branch) could not
-- rebuild it, and every later migration that touches it had to guard itself
-- with to_regclass(). This records the live definition as it stands --
-- columns, checks, indexes, RLS policies and the updated_at trigger -- read
-- back from the catalog on 2026-10-10.
--
-- Everything is inside `IF to_regclass(...) IS NULL`, so on the live project
-- (where the table exists) this file changes nothing at all. It only builds
-- the table where it is missing.
--
-- The voice code itself (voiceTranscriptionService.ts, VoiceRecorder.tsx) is
-- do-not-touch and is not affected: this is the same table it already uses.
--
-- Grants are left to the schema's default privileges, as for every other
-- table; tightening them is part of the RLS phase, not this capture.
-- ============================================================================

DO $capture$
BEGIN
    IF to_regclass('public.speech_transcriptions') IS NOT NULL THEN
        RETURN;
    END IF;

    CREATE TABLE public.speech_transcriptions (
        recording_id     UUID        NOT NULL,
        user_id          UUID        NOT NULL,
        source           TEXT        NOT NULL,
        status           TEXT        NOT NULL DEFAULT 'pending',
        transcript       TEXT,
        mime_type        TEXT,
        duration_seconds NUMERIC,
        language         TEXT,
        error_message    TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at     TIMESTAMPTZ,
        CONSTRAINT speech_transcriptions_pkey PRIMARY KEY (recording_id),
        CONSTRAINT speech_transcriptions_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
        CONSTRAINT speech_transcriptions_source_check
            CHECK (source = ANY (ARRAY['step2', 'general_opinion', 'question', 'answer', 'reply', 'feedback'])),
        CONSTRAINT speech_transcriptions_status_check
            CHECK (status = ANY (ARRAY['pending', 'uploading', 'uploaded', 'processing', 'completed', 'failed']))
    );

    CREATE INDEX idx_speech_transcriptions_user       ON public.speech_transcriptions (user_id);
    CREATE INDEX idx_speech_transcriptions_status     ON public.speech_transcriptions (status);
    CREATE INDEX idx_speech_transcriptions_source     ON public.speech_transcriptions (source);
    CREATE INDEX idx_speech_transcriptions_created_at ON public.speech_transcriptions (created_at DESC);

    ALTER TABLE public.speech_transcriptions ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "Users can create their own speech transcriptions"
        ON public.speech_transcriptions FOR INSERT
        WITH CHECK (auth.uid() = user_id);
    CREATE POLICY "Users can view their own speech transcriptions"
        ON public.speech_transcriptions FOR SELECT
        USING (auth.uid() = user_id);
    CREATE POLICY "Users can update their own speech transcriptions"
        ON public.speech_transcriptions FOR UPDATE
        USING (auth.uid() = user_id)
        WITH CHECK (auth.uid() = user_id);
    CREATE POLICY "Users can delete their own speech transcriptions"
        ON public.speech_transcriptions FOR DELETE
        USING (auth.uid() = user_id);

    -- Live this function has no search_path pinned (an advisor finding,
    -- fixed by 20261003_revoke_public_execute_grants.sql); created pinned here.
    CREATE OR REPLACE FUNCTION public.update_speech_transcription_updated_at()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = public
    AS $fn$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $fn$;

    REVOKE EXECUTE ON FUNCTION public.update_speech_transcription_updated_at() FROM PUBLIC, anon, authenticated;

    CREATE TRIGGER trg_update_speech_transcription_updated_at
        BEFORE UPDATE ON public.speech_transcriptions
        FOR EACH ROW EXECUTE FUNCTION public.update_speech_transcription_updated_at();
END
$capture$;
