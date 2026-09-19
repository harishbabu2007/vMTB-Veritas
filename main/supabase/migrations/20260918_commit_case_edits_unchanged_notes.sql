-- Follow-up to 20260918_case_pipeline_runs.sql: commit_case_edits() treats
-- "Your data" as changed only when its title or text actually differs.
-- Re-saving identical notes (a user repeating an edit because nothing seemed
-- to happen) now returns NOTHING_TO_SAVE instead of starting a pointless run
-- and asking for re-verification. Same function body as the updated
-- definition in 20260918_case_pipeline_runs.sql.

CREATE OR REPLACE FUNCTION public.commit_case_edits(
    p_case_id UUID,
    p_session_id UUID,
    p_documents JSONB DEFAULT '[]'::jsonb,
    p_delete_files TEXT[] DEFAULT '{}',
    p_upload_files JSONB DEFAULT '[]'::jsonb,
    p_additional_data JSONB DEFAULT NULL,
    p_empty_action TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_existing public.case_pipeline_runs;
    v_run public.case_pipeline_runs;
    v_gen BIGINT;
    v_doc JSONB;
    v_change JSONB;
    v_name TEXT;
    v_file JSONB;
    v_count INTEGER;
    v_docs_changed INTEGER := 0;
    v_removed INTEGER := 0;
    v_added INTEGER := 0;
    v_remaining INTEGER;
    v_text TEXT;
    v_archive BOOLEAN := false;
    v_has_uploads BOOLEAN;
    v_upload_names TEXT[] := '{}';
    v_rows INTEGER;
    v_notes_changed BOOLEAN := false;
    v_old_title TEXT;
    v_old_text TEXT;
BEGIN
    SELECT * INTO v_existing FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.case_id <> p_case_id THEN
            RAISE EXCEPTION 'INVALID_CHANGE';
        END IF;
        RETURN public._run_json(v_existing, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);

    -- Re-check under the lock: a concurrent retry of the same session may
    -- have committed while we waited.
    SELECT * INTO v_existing FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_existing.id IS NOT NULL THEN
        RETURN public._run_json(v_existing, true);
    END IF;

    p_documents := coalesce(p_documents, '[]'::jsonb);
    p_delete_files := coalesce(p_delete_files, '{}');
    p_upload_files := coalesce(p_upload_files, '[]'::jsonb);
    v_has_uploads := jsonb_array_length(p_upload_files) > 0;

    IF jsonb_array_length(p_documents) = 0 AND cardinality(p_delete_files) = 0
       AND NOT v_has_uploads AND p_additional_data IS NULL THEN
        RAISE EXCEPTION 'NOTHING_TO_SAVE';
    END IF;

    v_gen := v_case.content_generation + 1;

    -- Removals first, so a document removed in this batch isn't also edited.
    FOREACH v_name IN ARRAY p_delete_files LOOP
        UPDATE public.case_documents
        SET deleted_at = now(), deleted_generation = v_gen, deleted_by = auth.uid()
        WHERE case_id = p_case_id
          AND document_name = public.document_key(v_name)
          AND deleted_at IS NULL;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count = 0 THEN
            -- Legacy documents uploaded before registration existed have no
            -- row: record the removal anyway, so every reader excludes it.
            IF EXISTS (SELECT 1 FROM public.case_documents
                       WHERE case_id = p_case_id AND document_name = public.document_key(v_name)) THEN
                CONTINUE; -- already removed
            END IF;
            INSERT INTO public.case_documents (case_id, file_name, document_name, added_generation,
                                               deleted_at, deleted_generation, deleted_by)
            VALUES (p_case_id, regexp_replace(v_name, '^ANO_NNCMFAGSSS_[0-9]+_', ''),
                    public.document_key(v_name), 0, now(), v_gen, auth.uid());
        END IF;
        v_removed := v_removed + 1;
    END LOOP;

    -- Redaction changes.
    FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents) LOOP
        v_name := public.document_key(v_doc->>'document_filename');
        IF v_name IS NULL OR v_name = '' THEN
            RAISE EXCEPTION 'INVALID_CHANGE';
        END IF;
        CONTINUE WHEN v_name = ANY (SELECT public.document_key(f) FROM unnest(p_delete_files) f);

        -- Originals are retained once anonymization has finished for this
        -- document; without them there is nothing to redact against yet.
        IF NOT EXISTS (SELECT 1 FROM public.case_document_retention
                       WHERE case_id = p_case_id AND document_name = v_name) THEN
            RAISE EXCEPTION 'DOCUMENT_NOT_READY:%', v_name;
        END IF;

        v_count := 0;
        FOR v_change IN SELECT * FROM jsonb_array_elements(coalesce(v_doc->'changes', '[]'::jsonb)) LOOP
            IF v_change->>'action' = 'add' THEN
                IF (v_change->>'page_number')::int < 0
                   OR (v_change->'bbox'->>'x0')::numeric NOT BETWEEN 0 AND 1
                   OR (v_change->'bbox'->>'x1')::numeric NOT BETWEEN 0 AND 1
                   OR (v_change->'bbox'->>'y0')::numeric NOT BETWEEN 0 AND 1
                   OR (v_change->'bbox'->>'y1')::numeric NOT BETWEEN 0 AND 1
                   OR coalesce(v_change->>'style', 'whiteout') NOT IN ('blur', 'whiteout', 'blackout') THEN
                    RAISE EXCEPTION 'INVALID_CHANGE';
                END IF;
                -- The same box already active (a repeated save, a user redoing
                -- an edit they thought didn't take): don't stack duplicates.
                CONTINUE WHEN EXISTS (
                    SELECT 1 FROM public.case_document_redactions r
                    WHERE r.case_id = p_case_id AND r.document_name = v_name AND r.is_active
                      AND r.page_number = (v_change->>'page_number')::int
                      AND r.style = coalesce(v_change->>'style', 'whiteout')
                      AND abs((r.bbox->>'x0')::numeric - (v_change->'bbox'->>'x0')::numeric) < 0.002
                      AND abs((r.bbox->>'y0')::numeric - (v_change->'bbox'->>'y0')::numeric) < 0.002
                      AND abs((r.bbox->>'x1')::numeric - (v_change->'bbox'->>'x1')::numeric) < 0.002
                      AND abs((r.bbox->>'y1')::numeric - (v_change->'bbox'->>'y1')::numeric) < 0.002
                );
                INSERT INTO public.case_document_redactions (
                    case_id, request_id, document_name, page_number, bbox, category, confidence,
                    style, source, is_active, created_by, created_generation)
                VALUES (p_case_id, v_case.request_id, v_name, (v_change->>'page_number')::int,
                        v_change->'bbox', NULL, NULL, coalesce(v_change->>'style', 'whiteout'),
                        'manual', true, auth.uid(), v_gen);
                v_count := v_count + 1;
            ELSIF v_change->>'action' = 'remove' THEN
                UPDATE public.case_document_redactions
                SET is_active = false, removed_at = now(), removed_by = auth.uid(), removed_generation = v_gen
                WHERE id = (v_change->>'redaction_id')::uuid
                  AND case_id = p_case_id AND document_name = v_name AND is_active;
                GET DIAGNOSTICS v_rows = ROW_COUNT;
                v_count := v_count + v_rows;
            ELSE
                RAISE EXCEPTION 'INVALID_CHANGE';
            END IF;
        END LOOP;
        IF v_count > 0 THEN
            v_docs_changed := v_docs_changed + 1;
        END IF;
    END LOOP;

    -- Uploads (bytes already in S3).
    FOR v_file IN SELECT * FROM jsonb_array_elements(p_upload_files) LOOP
        v_name := public.document_key(v_file->>'file_name');
        IF EXISTS (SELECT 1 FROM public.case_documents
                   WHERE case_id = p_case_id AND document_name = v_name AND deleted_at IS NULL) THEN
            RAISE EXCEPTION 'DUPLICATE_DOCUMENT:%', v_name;
        END IF;
        INSERT INTO public.case_documents (case_id, file_name, size, type, storage_path, document_name, added_generation)
        VALUES (p_case_id, v_file->>'file_name', v_file->>'size', v_file->>'type',
                'uploads/' || v_case.request_id || '/data/' || (v_file->>'file_name'), v_name, v_gen);
        -- A re-added name must not inherit the removed document's regions.
        UPDATE public.case_document_redactions
        SET is_active = false, removed_generation = v_gen
        WHERE case_id = p_case_id AND document_name = v_name AND is_active;
        v_upload_names := v_upload_names || (v_file->>'file_name');
        v_added := v_added + 1;
    END LOOP;

    IF p_additional_data IS NOT NULL THEN
        SELECT document_title, document_data INTO v_old_title, v_old_text
        FROM public.case_additional_documents WHERE case_id = p_case_id;
        -- Saving the same notes again isn't a change (and mustn't start a run).
        IF NOT FOUND
           OR v_old_title IS DISTINCT FROM coalesce(nullif(p_additional_data->>'title', ''), 'Additional Data')
           OR coalesce(v_old_text, '') IS DISTINCT FROM coalesce(p_additional_data->>'content', '') THEN
            INSERT INTO public.case_additional_documents (case_id, document_title, document_data)
            VALUES (p_case_id, coalesce(nullif(p_additional_data->>'title', ''), 'Additional Data'),
                    coalesce(p_additional_data->>'content', ''))
            ON CONFLICT (case_id) DO UPDATE
            SET document_title = EXCLUDED.document_title, document_data = EXCLUDED.document_data, updated_at = now();
            v_notes_changed := true;
        END IF;
    END IF;

    -- Every change was already in effect (a repeated save, or a redo of an
    -- edit that had in fact landed): don't start a pointless run.
    IF v_docs_changed = 0 AND v_removed = 0 AND v_added = 0 AND NOT v_notes_changed THEN
        RAISE EXCEPTION 'NOTHING_TO_SAVE';
    END IF;

    -- Nothing left to summarize?
    SELECT count(*) INTO v_remaining FROM public.case_documents WHERE case_id = p_case_id AND deleted_at IS NULL;
    SELECT document_data INTO v_text FROM public.case_additional_documents WHERE case_id = p_case_id;
    IF v_remaining = 0 AND coalesce(btrim(v_text), '') = '' THEN
        IF p_empty_action IS DISTINCT FROM 'archive' THEN
            RAISE EXCEPTION 'CASE_WOULD_BE_EMPTY';
        END IF;
        v_archive := true;
    END IF;

    PERFORM public._supersede_active_runs(p_case_id);

    INSERT INTO public.case_pipeline_runs (
        id, case_id, generation, kind, status, has_uploads, upload_files,
        materialize_done, anonymize_done, summary_done,
        documents_changed, documents_removed, documents_added, created_by)
    VALUES (
        p_session_id, p_case_id, v_gen, 'edit', 'pending', v_has_uploads, v_upload_names,
        false, NOT v_has_uploads,
        -- An emptied, archived case has nothing to summarize.
        v_archive,
        v_docs_changed, v_removed, v_added, auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.cases
    SET content_generation = v_gen,
        summary_status = CASE WHEN v_archive THEN 'failed' ELSE 'processing' END,
        report_status = CASE WHEN v_has_uploads THEN 'not_ready' ELSE report_status END,
        archived_at = CASE WHEN v_archive THEN coalesce(archived_at, now()) ELSE archived_at END
    WHERE id = p_case_id;

    IF v_archive THEN
        -- Same invariant as archive_case(): archived cases aren't shared.
        DELETE FROM public.mtb_cases WHERE case_id = p_case_id;
    END IF;

    RETURN public._run_json(v_run, false) || jsonb_build_object('archived', v_archive);
END;
$$;
