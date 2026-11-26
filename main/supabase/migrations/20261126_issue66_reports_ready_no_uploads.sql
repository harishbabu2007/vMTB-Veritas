-- Issue #66: Reports tab stuck on "Documents are being anonymized" for
-- cases with no documents.
--
-- cases.report_status only became ready ('verified') on the anonymize path
-- (pipeline_finish_anonymize / pipeline_mark_anonymized), which runs only
-- for runs with uploads. A notes-only case never runs it, so report_status
-- stayed at the column default 'not_ready' forever and the Reports tab
-- showed its blocking spinner (hiding Add documents and Your data).
--
-- Changes:
--   1. Write paths: a run with no uploads has nothing pending, so
--      start_initial_run, retry_case_run and commit_case_edits now set
--      report_status = 'verified' instead of leaving the old value.
--   2. get_case_run_state(): return a computed reports_pending boolean
--      (latest run pending/running with uploads not yet anonymized),
--      visible to owners and members alike -- the run row itself stays
--      owner-only.
--   3. Repair existing stuck rows: notes-only cases with no pending
--      anonymize run and no live documents get report_status = 'verified'.
--
-- Rollback: ../rollbacks/20261126_issue66_reports_ready_no_uploads_rollback.sql


-- ---------------------------------------------------------------------------
-- 1a. start_initial_run: notes-only first run is immediately ready
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_initial_run(p_case_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
    v_files TEXT[];
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_run.id IS NOT NULL THEN
        RETURN public._run_json(v_run, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);
    IF v_case.content_generation <> 0 THEN
        RAISE EXCEPTION 'ALREADY_STARTED';
    END IF;

    SELECT coalesce(array_agg(file_name), '{}') INTO v_files
    FROM public.case_documents WHERE case_id = p_case_id AND deleted_at IS NULL;

    INSERT INTO public.case_pipeline_runs (
        id, case_id, generation, kind, status, has_uploads, upload_files,
        materialize_done, anonymize_done, summary_done, documents_added, created_by)
    VALUES (
        p_session_id, p_case_id, 1, 'initial', 'pending', cardinality(v_files) > 0, v_files,
        true, cardinality(v_files) = 0, false, cardinality(v_files), auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.case_documents SET added_generation = 1 WHERE case_id = p_case_id;
    UPDATE public.cases
    SET content_generation = 1, summary_status = 'processing',
        report_status = CASE WHEN cardinality(v_files) > 0 THEN 'not_ready' ELSE 'verified' END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;


-- ---------------------------------------------------------------------------
-- 1b. retry_case_run: a retry with no uploads has nothing pending either
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_case_run(p_case_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_failed public.case_pipeline_runs;
    v_run public.case_pipeline_runs;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_run.id IS NOT NULL THEN
        RETURN public._run_json(v_run, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);
    PERFORM public._expire_stale_runs(p_case_id);

    SELECT * INTO v_failed FROM public.case_pipeline_runs
    WHERE case_id = p_case_id ORDER BY generation DESC LIMIT 1;
    IF v_failed.id IS NULL OR v_failed.status <> 'failed' OR v_failed.generation <> v_case.content_generation THEN
        RAISE EXCEPTION 'NOTHING_TO_RETRY';
    END IF;

    INSERT INTO public.case_pipeline_runs (
        id, case_id, generation, kind, status, has_uploads, upload_files,
        materialize_done, anonymize_done, summary_done, created_by)
    VALUES (
        p_session_id, p_case_id, v_case.content_generation + 1, 'retry', 'pending',
        v_failed.has_uploads, v_failed.upload_files,
        false, NOT v_failed.has_uploads, false, auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.cases
    SET content_generation = v_run.generation,
        summary_status = 'processing',
        report_status = CASE WHEN v_failed.has_uploads THEN 'not_ready' ELSE 'verified' END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;


-- ---------------------------------------------------------------------------
-- 1c. commit_case_edits: same rule on the edit path
--     (body: latest definition in 20260918_case_pipeline_runs.sql, which
--      includes the re-added-name and unchanged-notes follow-ups)
-- ---------------------------------------------------------------------------
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
    v_carried TEXT[];
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
    -- edit that has in fact landed): don't start a pointless run.
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

    -- Uploads from a run being superseded that haven't been converted and
    -- anonymized yet: this run takes them over (unless removed in this same
    -- save). Otherwise it would summarize before they exist and nothing
    -- would ever re-summarize them.
    SELECT coalesce(array_agg(DISTINCT f), '{}') INTO v_carried
    FROM public.case_pipeline_runs r, unnest(r.upload_files) f
    WHERE r.case_id = p_case_id AND r.status IN ('pending', 'running')
      AND r.has_uploads AND NOT r.anonymize_done
      -- still part of the case (a name removed and re-added counts as live)
      AND EXISTS (SELECT 1 FROM public.case_documents d
                  WHERE d.case_id = p_case_id AND d.document_name = public.document_key(f)
                    AND d.deleted_at IS NULL);
    v_upload_names := ARRAY(SELECT DISTINCT unnest(v_upload_names || v_carried));
    v_has_uploads := cardinality(v_upload_names) > 0;

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
        report_status = CASE WHEN v_has_uploads THEN 'not_ready' ELSE 'verified' END,
        archived_at = CASE WHEN v_archive THEN coalesce(archived_at, now()) ELSE archived_at END
    WHERE id = p_case_id;

    IF v_archive THEN
        -- Same invariant as archive_case(): archived cases aren't shared.
        DELETE FROM public.mtb_cases WHERE case_id = p_case_id;
    END IF;

    RETURN public._run_json(v_run, false) || jsonb_build_object('archived', v_archive);
END;
$$;


-- ---------------------------------------------------------------------------
-- 2. get_case_run_state: computed reports_pending, visible to everyone
--     (body: latest definition in 20261010_p1_rpc_and_view_hardening.sql;
--      only the added reports_pending field differs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_case_run_state(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
    v_superseded INTEGER;
    v_is_owner BOOLEAN;
    v_is_viewer BOOLEAN;
BEGIN
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;
    IF v_case.id IS NULL THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    v_is_owner := coalesce(v_case.owner_id = public.effective_owner_id(), false);
    v_is_viewer := v_is_owner
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc
                   JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                   WHERE mc.case_id = p_case_id AND mm.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc
                   JOIN public.mtbs m ON m.id = mc.mtb_id
                   WHERE mc.case_id = p_case_id
                     AND m.owner_id = public.effective_owner_id());
    IF NOT coalesce(v_is_viewer, false) THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    PERFORM public._expire_stale_runs(p_case_id);
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;

    SELECT * INTO v_run FROM public.case_pipeline_runs
    WHERE case_id = p_case_id ORDER BY generation DESC LIMIT 1;

    -- How many earlier runs the latest one replaced mid-flight (for "your
    -- newer changes replace the update in progress").
    SELECT count(*) INTO v_superseded FROM public.case_pipeline_runs
    WHERE case_id = p_case_id AND status = 'superseded'
      AND v_run.id IS NOT NULL AND finished_at >= v_run.created_at - interval '5 seconds';

    RETURN jsonb_build_object(
        'content_generation', v_case.content_generation,
        'summary_generation', v_case.summary_generation,
        'verified_generation', v_case.verified_generation,
        'summary_status', v_case.summary_status,
        'report_status', v_case.report_status,
        -- Reports are pending exactly when the latest run still owes an
        -- anonymize step. Computed, not stored: a notes-only case has no
        -- pending step (issue #66). Returned top-level, so members see it
        -- too -- unlike the run row below.
        'reports_pending', v_run.id IS NOT NULL
            AND v_run.status IN ('pending', 'running')
            AND v_run.has_uploads AND NOT v_run.anonymize_done,
        'archived_at', v_case.archived_at,
        'run', CASE WHEN v_run.id IS NULL OR NOT v_is_owner THEN NULL ELSE to_jsonb(v_run) END,
        'replaced_runs', CASE WHEN v_is_owner THEN v_superseded ELSE 0 END
    );
END;
$$;


-- ---------------------------------------------------------------------------
-- 3. Repair rows stuck by the old write paths
--     Cases matching the issue's "find affected cases" query that also have
--     no live documents (i.e. nothing left to anonymize). Cases with a
--     genuinely pending anonymize run are excluded by the NOT EXISTS above
--     and are left alone.
-- ---------------------------------------------------------------------------
UPDATE public.cases c
SET report_status = 'verified'
WHERE c.archived_at IS NULL
  AND c.report_status = 'not_ready'
  AND NOT EXISTS (
    SELECT 1 FROM public.case_pipeline_runs r
    WHERE r.case_id = c.id
      AND r.status IN ('pending', 'running')
      AND r.has_uploads AND NOT r.anonymize_done)
  AND NOT EXISTS (
    SELECT 1 FROM public.case_documents d
    WHERE d.case_id = c.id AND d.deleted_at IS NULL);
