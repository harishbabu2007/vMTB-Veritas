-- Fix batch (2026-09-15): first-ever-verification tracking + a server-side
-- capped "Regenerate Summary" counter.
--
-- first_verified_at: cases.summary_status already cycles back to
-- 'processing'/'unverified' on every later summary regeneration (redaction
-- edits, and now the new Regenerate Summary action below), so it can no
-- longer answer "has this case ever passed verification" — which is what
-- ViewCase.tsx needs to decide whether Reports/Opinions/Treatment/Settings
-- should be locked. This column is set once, in CasesContext.verifySummary,
-- and never cleared afterward.
--
-- summary_regeneration_count: caps the new owner-facing "Regenerate Summary"
-- action at 5 uses per case. Mirrors the existing whatsapp_otps
-- attempts/max_attempts capped-counter convention. Enforcement is the RPC
-- function below, not the UI: the UPDATE's WHERE clause makes the increment
-- atomic and conditional, so a client bypassing the app entirely still
-- cannot push the count past 5 or increment on a case it doesn't own — the
-- CHECK constraint is a backstop in case some future code path writes the
-- column directly instead of going through the function.
--
-- Scope note: this counter is only touched by increment_summary_regeneration_count
-- below (the user-initiated "I don't like this summary" action). The existing
-- redaction-triggered resummarize (_shared/redaction_core.py) is a separate,
-- system-necessary flow and intentionally does not count against this cap.

ALTER TABLE public.cases
    ADD COLUMN IF NOT EXISTS first_verified_at TIMESTAMPTZ;

ALTER TABLE public.cases
    ADD COLUMN IF NOT EXISTS summary_regeneration_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.cases
    DROP CONSTRAINT IF EXISTS cases_summary_regeneration_count_check;
ALTER TABLE public.cases
    ADD CONSTRAINT cases_summary_regeneration_count_check
    CHECK (summary_regeneration_count >= 0 AND summary_regeneration_count <= 5);

COMMENT ON COLUMN public.cases.first_verified_at IS
    'Set once, the first time this case is verified (CasesContext.verifySummary); never cleared by a later regeneration. Distinct from summary_status, which does cycle back to processing/unverified on every regeneration -- ViewCase.tsx locks Reports/Opinions/Treatment/Settings only until this is first set, not on live summary_status.';
COMMENT ON COLUMN public.cases.summary_regeneration_count IS
    'Incremented only by increment_summary_regeneration_count(), only for the owner-facing "Regenerate Summary" action. Capped at 5 (see CHECK constraint); does not count redaction-triggered resummarization.';

-- Atomically increment the regeneration counter and flip the case back to
-- processing, but only if the caller owns the case and the cap isn't hit.
-- Returns the new count, or NULL if the row wasn't updated (cap reached,
-- not found, or not owned by the caller) -- the frontend treats NULL as
-- "regeneration limit reached" regardless of which of those it was.
CREATE OR REPLACE FUNCTION public.increment_summary_regeneration_count(p_case_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_count INTEGER;
BEGIN
    UPDATE public.cases
    SET summary_regeneration_count = summary_regeneration_count + 1,
        summary_status = 'processing',
        report_status = 'not_ready'
    WHERE id = p_case_id
      AND owner_id = auth.uid()
      AND summary_regeneration_count < 5
    RETURNING summary_regeneration_count INTO v_new_count;

    RETURN v_new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_summary_regeneration_count(UUID) TO authenticated;
