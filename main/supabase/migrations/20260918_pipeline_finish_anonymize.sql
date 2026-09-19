-- Integrity check for anonymization (see 20260918_case_pipeline_runs.sql).
--
-- VMTB-OCR2ANO-V2 finishes a pass by completing the anonymize step of every
-- upload run committed before it started. If a document one of those runs
-- uploaded did NOT come out as an anonymized PDF, reporting that run as
-- complete would leave a silently half-applied state — a document the owner
-- added that just never appears (this happened while testing). Instead the
-- run fails with the missing document names, and the owner can retry.
--
-- Only each run's own uploads are checked (plain-text documents aren't
-- anonymized into PDFs; documents removed since don't count), so an unrelated
-- legacy document elsewhere in the case can't fail new uploads.

CREATE OR REPLACE FUNCTION public.pipeline_finish_anonymize(
    p_request_id TEXT,
    p_started_at TIMESTAMPTZ,
    p_published TEXT[]   -- document names that now exist as ANO_<name>.pdf
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case_id UUID;
    r RECORD;
    v_missing TEXT[];
    v_completed INTEGER := 0;
    v_failed INTEGER := 0;
BEGIN
    SELECT id INTO v_case_id FROM public.cases WHERE request_id = p_request_id;
    IF v_case_id IS NULL THEN
        RETURN jsonb_build_object('completed', 0, 'failed', 0);
    END IF;

    FOR r IN
        SELECT id, upload_files FROM public.case_pipeline_runs
        WHERE case_id = v_case_id AND has_uploads AND NOT anonymize_done
          AND status IN ('pending', 'running') AND created_at <= p_started_at
    LOOP
        SELECT coalesce(array_agg(DISTINCT public.document_key(f)), '{}') INTO v_missing
        FROM unnest(r.upload_files) f
        WHERE lower(f) NOT LIKE '%.txt'
          AND public.document_key(f) <> ALL (coalesce(p_published, '{}'))
          AND EXISTS (SELECT 1 FROM public.case_documents d
                      WHERE d.case_id = v_case_id AND d.document_name = public.document_key(f)
                        AND d.deleted_at IS NULL);

        IF cardinality(v_missing) > 0 THEN
            IF public.pipeline_fail(r.id, 'ANONYMIZE_INCOMPLETE',
                   'These documents couldn''t be processed: ' || array_to_string(v_missing, ', ') || '.') THEN
                v_failed := v_failed + 1;
            END IF;
        ELSE
            UPDATE public.case_pipeline_runs SET anonymize_done = true, updated_at = now() WHERE id = r.id;
            PERFORM public._complete_run_if_done(r.id);
            v_completed := v_completed + 1;
        END IF;
    END LOOP;

    -- Reports are ready once no upload run is still waiting to be anonymized.
    UPDATE public.cases
    SET report_status = 'verified'
    WHERE id = v_case_id
      AND NOT EXISTS (SELECT 1 FROM public.case_pipeline_runs
                      WHERE case_id = v_case_id AND has_uploads AND NOT anonymize_done
                        AND status IN ('pending', 'running'));

    RETURN jsonb_build_object('completed', v_completed, 'failed', v_failed);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pipeline_finish_anonymize(TEXT, TIMESTAMPTZ, TEXT[]) TO anon, authenticated, service_role;
