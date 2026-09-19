-- Case pipeline runs: durable, ordered, idempotent document edits.
--
-- Problem this solves: editing a case's documents (redactions, removals,
-- uploads, "Your data") kicks off slow asynchronous work — anonymization,
-- then summarization — across several Lambdas. Before this migration the
-- browser fired those Lambdas directly with the edit as the payload, so:
--   * a save was "done" as soon as a fire-and-forget trigger said 200, even
--     when the Lambda rejected it (a removed document came back on refresh);
--   * overlapping runs raced — whichever Extract finished last overwrote the
--     summary, age/sex and status, even if it was summarizing older input;
--   * a failed run left the case in 'processing' forever;
--   * deletes never updated case_documents, and nothing was idempotent.
--
-- Model (see docs/DOCUMENT_AI_PIPELINE.md, "Edits and pipeline runs"):
--   1. INTENT IN POSTGRES. commit_case_edits() writes the whole batch
--      (redaction rows, document removals/registrations, additional data) in
--      ONE transaction under a row lock on the case, bumps
--      cases.content_generation, and records a case_pipeline_runs row. It is
--      idempotent on the client session id. The save is only reported as
--      saved once this returns.
--   2. IDEMPOTENT MATERIALIZERS. Lambdas are then triggered with just the run
--      id. They rebuild from the database's CURRENT intent (not from their
--      request), so delivery order doesn't matter and re-running is safe.
--   3. GENERATION COMPARE-AND-SET. Every write a run makes back to the case
--      (summary, age/sex, statuses) goes through a pipeline_* function that
--      only applies it if cases.content_generation still equals the run's
--      generation. A superseded run's writes match nothing. (Anonymized PDFs
--      are protected by S3 conditional writes in the Apply Lambda.)
--
-- Why not a lock or a queue: runs take minutes; a lock held that long blocks
-- the user and is orphaned when a Lambda dies, and a "start the next run"
-- queue stalls silently when the handoff is lost. Compare-and-set holds
-- nothing across steps: a crashed run is simply stale.
--
-- Stuck runs: there is no scheduler. get_case_run_state() expires runs on
-- read — pending for > 2 min (never started) or running with no progress for
-- > 30 min — marking them failed so the user sees a Retry.
--
-- Security: RLS stays OFF on these tables, matching this schema's baseline
-- (see docs/LEGACY_AND_KNOWN_ISSUES.md). The user-facing functions check
-- auth.uid() ownership; the pipeline_* functions are called by Lambdas with
-- the anon key and so are callable by any client, exactly like the direct
-- table writes RLS-off already allows. The guarantees here are against
-- races between legitimate code paths, not a hostile client; that needs the
-- deferred lock-down in migrations_deferred/.
--
-- Supersedes 20260917_document_edit_sessions.sql, which was never applied.

-- ============================================================================
-- Columns
-- ============================================================================

ALTER TABLE public.cases
    ADD COLUMN IF NOT EXISTS content_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS summary_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS verified_generation BIGINT,
    ADD COLUMN IF NOT EXISTS verified_snapshot JSONB;

COMMENT ON COLUMN public.cases.content_generation IS
    'Bumped by every committed change to the case''s documents or additional data (and by regenerate/retry). Pipeline runs carry the generation they were started for and may only write results while it is still current.';
COMMENT ON COLUMN public.cases.summary_generation IS
    'The content_generation the current summary was produced from. summary_generation < content_generation means the summary is out of date (a run is in progress or failed).';
COMMENT ON COLUMN public.cases.verified_snapshot IS
    'What the owner last verified: {summary, patient_age, patient_sex, cancer_type, notes, verified_at}. MTB members are shown this (and the document versions as of verified_generation) while a newer version is unverified.';

ALTER TABLE public.case_documents
    ADD COLUMN IF NOT EXISTS document_name TEXT,
    ADD COLUMN IF NOT EXISTS added_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deleted_generation BIGINT,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by UUID,
    ADD COLUMN IF NOT EXISTS deleted_s3_key TEXT;

COMMENT ON COLUMN public.case_documents.document_name IS
    'The pipeline''s name for the document: the file name without its extension (ngs.pdf -> ngs). Same key as case_document_redactions/_versions.document_name and the ANO_NNCMFAGSSS_22246_<name>.pdf file in S3.';

UPDATE public.case_documents
SET document_name = regexp_replace(file_name, '\.[^./]+$', '')
WHERE document_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_documents_live
    ON public.case_documents (case_id, document_name) WHERE deleted_at IS NULL;

ALTER TABLE public.case_document_redactions
    ADD COLUMN IF NOT EXISTS created_generation BIGINT,
    ADD COLUMN IF NOT EXISTS removed_generation BIGINT;

ALTER TABLE public.case_document_versions
    ADD COLUMN IF NOT EXISTS generation BIGINT;

-- ============================================================================
-- Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.case_pipeline_runs (
    -- The client-generated session id: resubmitting the same save is a no-op.
    id UUID PRIMARY KEY,
    case_id UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
    generation BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'edit', 'regenerate', 'retry')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'superseded')),
    has_uploads BOOLEAN NOT NULL DEFAULT false,
    upload_files TEXT[] NOT NULL DEFAULT '{}',
    -- Steps; a run completes when all three are done. Steps a run doesn't
    -- need are created already done.
    materialize_done BOOLEAN NOT NULL DEFAULT false,  -- Apply: removals + redaction regeneration
    anonymize_done BOOLEAN NOT NULL DEFAULT true,     -- OCR2ANO, only for runs with uploads
    summary_done BOOLEAN NOT NULL DEFAULT false,      -- Extract
    documents_changed INTEGER NOT NULL DEFAULT 0,
    documents_removed INTEGER NOT NULL DEFAULT 0,
    documents_added INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    UNIQUE (case_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_case_pipeline_runs_case
    ON public.case_pipeline_runs (case_id, generation DESC);

GRANT ALL ON public.case_pipeline_runs TO anon, authenticated, service_role;

-- ============================================================================
-- Helpers
-- ============================================================================

-- ANO_NNCMFAGSSS_22246_ngs.pdf -> ngs ; Clinical Details.txt -> Clinical Details
CREATE OR REPLACE FUNCTION public.document_key(p_filename TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT regexp_replace(regexp_replace(p_filename, '^ANO_NNCMFAGSSS_[0-9]+_', ''), '\.[^./]+$', '');
$$;

-- Supersede every unfinished run of a case (callers hold the case row lock).
-- A regeneration thrown away before producing a summary gives its use of the
-- 5-per-case cap back: the user never got the summary they spent it on.
CREATE OR REPLACE FUNCTION public._supersede_active_runs(p_case_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_refunds INTEGER;
BEGIN
    WITH superseded AS (
        UPDATE public.case_pipeline_runs
        SET status = 'superseded', updated_at = now(), finished_at = now()
        WHERE case_id = p_case_id AND status IN ('pending', 'running')
        RETURNING kind, summary_done
    )
    SELECT count(*) INTO v_refunds FROM superseded WHERE kind = 'regenerate' AND NOT summary_done;

    IF v_refunds > 0 THEN
        UPDATE public.cases
        SET summary_regeneration_count = greatest(summary_regeneration_count - v_refunds, 0)
        WHERE id = p_case_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._run_json(r public.case_pipeline_runs, p_duplicate BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
    SELECT to_jsonb(r) || jsonb_build_object('duplicate', p_duplicate);
$$;

-- Lock and return the caller's case, or raise.
CREATE OR REPLACE FUNCTION public._lock_owned_case(p_case_id UUID)
RETURNS public.cases
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
    END IF;
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id FOR UPDATE;
    IF v_case.id IS NULL OR v_case.owner_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = '42501';
    END IF;
    RETURN v_case;
END;
$$;

-- ============================================================================
-- User-facing: commit an edit session
-- ============================================================================
--
-- p_documents:    [{"document_filename": "ANO_..._ngs.pdf",
--                   "changes": [{"action":"add","page_number":0,"bbox":{x0,y0,x1,y1},"style":"whiteout"},
--                               {"action":"remove","redaction_id":"<uuid>"}]}]
-- p_delete_files: filenames as listed by VMTB-GET-REPORTS (or pending upload names)
-- p_upload_files: [{"file_name","size","type"}] — already uploaded to S3 data/
-- p_additional_data: {"title","content"} or null (unchanged)
-- p_empty_action: null, or 'archive' — required when the result would leave
--                 the case with no documents and no additional text.
--
-- Error codes (raised as the exception message): NOT_AUTHENTICATED,
-- NOT_OWNER, NOTHING_TO_SAVE (nothing given, or everything given was already
-- in effect), DOCUMENT_NOT_READY:<name>,
-- DOCUMENT_NOT_FOUND:<name>, DUPLICATE_DOCUMENT:<name>, INVALID_CHANGE,
-- CASE_WOULD_BE_EMPTY.
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

-- ============================================================================
-- User-facing: regenerate, retry, verify, manual summary edits, state
-- ============================================================================

-- Replaces increment_summary_regeneration_count() for the "Regenerate
-- Summary" action: same cap, but refused while any run is in progress (the
-- run in progress will produce a new summary anyway), and it only
-- re-summarizes — documents don't need re-anonymizing.
CREATE OR REPLACE FUNCTION public.start_regeneration(p_case_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_session_id;
    IF v_run.id IS NOT NULL THEN
        RETURN public._run_json(v_run, true);
    END IF;

    v_case := public._lock_owned_case(p_case_id);
    PERFORM public._expire_stale_runs(p_case_id);

    IF EXISTS (SELECT 1 FROM public.case_pipeline_runs WHERE case_id = p_case_id AND status IN ('pending', 'running')) THEN
        RAISE EXCEPTION 'RUN_IN_PROGRESS';
    END IF;
    IF v_case.summary_regeneration_count >= 5 THEN
        RAISE EXCEPTION 'REGENERATION_LIMIT';
    END IF;

    INSERT INTO public.case_pipeline_runs (id, case_id, generation, kind, status, materialize_done, anonymize_done, summary_done, created_by)
    VALUES (p_session_id, p_case_id, v_case.content_generation + 1, 'regenerate', 'pending', true, true, false, auth.uid())
    RETURNING * INTO v_run;

    UPDATE public.cases
    SET content_generation = v_run.generation,
        summary_regeneration_count = summary_regeneration_count + 1,
        summary_status = 'processing'
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;

-- A newly created case: its first processing run (every uploaded document
-- still needs anonymizing and summarizing). Called by case creation right
-- after the documents are uploaded and registered.
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
        report_status = CASE WHEN cardinality(v_files) > 0 THEN 'not_ready' ELSE report_status END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;

-- Retry after a failed run. Not counted against the regeneration cap: the
-- failure wasn't the user's choice. Re-does every step the failed run needed.
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
        report_status = CASE WHEN v_failed.has_uploads THEN 'not_ready' ELSE report_status END
    WHERE id = p_case_id;

    RETURN public._run_json(v_run, false);
END;
$$;

-- Verify only the summary of the latest save, and only once it exists.
-- p_generation is the content_generation the client was looking at: a tab
-- showing an older version can't verify a newer summary it never displayed.
-- Error codes: SUMMARY_NOT_READY, STALE_GENERATION, PATIENT_DETAILS_MISSING.
CREATE OR REPLACE FUNCTION public.verify_case_summary(p_case_id UUID, p_generation BIGINT)
RETURNS SETOF public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
BEGIN
    v_case := public._lock_owned_case(p_case_id);

    IF v_case.content_generation <> p_generation THEN
        RAISE EXCEPTION 'STALE_GENERATION';
    END IF;
    IF v_case.summary_status <> 'unverified' OR v_case.summary_generation <> v_case.content_generation THEN
        RAISE EXCEPTION 'SUMMARY_NOT_READY';
    END IF;
    IF v_case.patient_age IS NULL OR v_case.patient_sex IS NULL THEN
        RAISE EXCEPTION 'PATIENT_DETAILS_MISSING';
    END IF;

    RETURN QUERY
    UPDATE public.cases
    SET summary_status = 'verified',
        first_verified_at = coalesce(first_verified_at, now()),
        verified_generation = content_generation,
        verified_snapshot = jsonb_build_object(
            'summary', summary,
            'patient_age', patient_age,
            'patient_sex', patient_sex,
            'cancer_type', cancer_type,
            'notes', (SELECT jsonb_build_object('title', a.document_title, 'content', a.document_data)
                      FROM public.case_additional_documents a WHERE a.case_id = p_case_id),
            'verified_at', now())
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

-- The owner's manual edit of the summary / patient details. Refused while a
-- run is producing a new summary (it would be overwritten), or if the client
-- was looking at an older version. When p_verify, verifies in the same step.
CREATE OR REPLACE FUNCTION public.save_case_summary_edit(
    p_case_id UUID,
    p_generation BIGINT,
    p_summary TEXT,
    p_patient_name TEXT,
    p_patient_age INTEGER,
    p_patient_sex TEXT,
    p_cancer_type TEXT,
    p_verify BOOLEAN DEFAULT false
)
RETURNS SETOF public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
BEGIN
    v_case := public._lock_owned_case(p_case_id);

    IF v_case.content_generation <> p_generation THEN
        RAISE EXCEPTION 'STALE_GENERATION';
    END IF;
    IF v_case.summary_status = 'processing' THEN
        RAISE EXCEPTION 'SUMMARY_NOT_READY';
    END IF;
    IF p_verify AND (p_patient_age IS NULL OR p_patient_sex IS NULL OR coalesce(p_patient_sex, '') = '') THEN
        RAISE EXCEPTION 'PATIENT_DETAILS_MISSING';
    END IF;

    RETURN QUERY
    UPDATE public.cases
    SET summary = p_summary,
        patient_name = p_patient_name,
        patient_age = p_patient_age,
        patient_sex = nullif(p_patient_sex, ''),
        cancer_type = p_cancer_type,
        summary_generation = content_generation,
        summary_status = CASE WHEN p_verify THEN 'verified' ELSE 'unverified' END,
        first_verified_at = CASE WHEN p_verify THEN coalesce(first_verified_at, now()) ELSE first_verified_at END,
        verified_generation = CASE WHEN p_verify THEN content_generation ELSE verified_generation END,
        verified_snapshot = CASE WHEN p_verify THEN jsonb_build_object(
            'summary', p_summary, 'patient_age', p_patient_age, 'patient_sex', nullif(p_patient_sex, ''),
            'cancer_type', p_cancer_type,
            'notes', (SELECT jsonb_build_object('title', a.document_title, 'content', a.document_data)
                      FROM public.case_additional_documents a WHERE a.case_id = p_case_id),
            'verified_at', now()) ELSE verified_snapshot END
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

-- Mark runs that can no longer be making progress as failed. No scheduler:
-- called whenever run state is read or a new run is started.
CREATE OR REPLACE FUNCTION public._expire_stale_runs(p_case_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    r public.case_pipeline_runs;
BEGIN
    FOR r IN
        UPDATE public.case_pipeline_runs
        SET status = 'failed',
            error_code = CASE WHEN status = 'pending' THEN 'NOT_STARTED' ELSE 'TIMED_OUT' END,
            error = CASE WHEN status = 'pending'
                         THEN 'Processing didn''t start.'
                         ELSE 'Processing stopped responding.' END,
            updated_at = now(), finished_at = now()
        WHERE case_id = p_case_id
          AND ((status = 'pending' AND created_at < now() - interval '2 minutes')
            OR (status = 'running' AND updated_at < now() - interval '30 minutes'))
        RETURNING *
    LOOP
        UPDATE public.cases SET summary_status = 'failed'
        WHERE id = p_case_id AND content_generation = r.generation;
    END LOOP;
END;
$$;

-- What the UI needs to show a case's update state. Readable by the owner and
-- by members of an MTB the case is shared into.
CREATE OR REPLACE FUNCTION public.get_case_run_state(p_case_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case public.cases;
    v_run public.case_pipeline_runs;
    v_superseded INTEGER;
BEGIN
    SELECT * INTO v_case FROM public.cases WHERE id = p_case_id;
    IF v_case.id IS NULL OR NOT (
        v_case.owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.mtb_cases mc JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                   WHERE mc.case_id = p_case_id AND mm.user_id = auth.uid())
    ) THEN
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
        'archived_at', v_case.archived_at,
        'run', CASE WHEN v_run.id IS NULL THEN NULL ELSE to_jsonb(v_run) END,
        'replaced_runs', v_superseded
    );
END;
$$;

-- ============================================================================
-- Pipeline (Lambdas): claim, progress, results, failure
-- ============================================================================

-- Claim a run. Returns the run joined with the case's current generation and
-- request id, and moves pending -> running. A run that is already terminal,
-- or no longer current, comes back with "current": false and must stop.
CREATE OR REPLACE FUNCTION public.pipeline_begin(p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.case_pipeline_runs;
    v_case public.cases;
    v_current BOOLEAN;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_run_id FOR UPDATE;
    IF v_run.id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_case FROM public.cases WHERE id = v_run.case_id;

    v_current := v_case.content_generation = v_run.generation AND v_run.status IN ('pending', 'running');
    IF v_run.status IN ('pending', 'running') AND v_case.content_generation <> v_run.generation THEN
        UPDATE public.case_pipeline_runs SET status = 'superseded', updated_at = now(), finished_at = now()
        WHERE id = p_run_id RETURNING * INTO v_run;
    ELSIF v_run.status = 'pending' THEN
        UPDATE public.case_pipeline_runs SET status = 'running', updated_at = now()
        WHERE id = p_run_id RETURNING * INTO v_run;
    ELSIF v_run.status = 'running' THEN
        UPDATE public.case_pipeline_runs SET updated_at = now() WHERE id = p_run_id RETURNING * INTO v_run;
    END IF;

    RETURN to_jsonb(v_run) || jsonb_build_object(
        'current', v_current,
        'request_id', v_case.request_id,
        'content_generation', v_case.content_generation);
END;
$$;

-- Is this run still the one that may write results? Cheap check between
-- expensive steps; also refreshes the progress clock.
CREATE OR REPLACE FUNCTION public.pipeline_is_current(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_current BOOLEAN;
BEGIN
    UPDATE public.case_pipeline_runs r
    SET updated_at = now()
    FROM public.cases c
    WHERE r.id = p_run_id AND c.id = r.case_id
      AND r.status = 'running' AND c.content_generation = r.generation
    RETURNING true INTO v_current;
    RETURN coalesce(v_current, false);
END;
$$;

CREATE OR REPLACE FUNCTION public._complete_run_if_done(p_run_id UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
    UPDATE public.case_pipeline_runs
    SET status = 'completed', updated_at = now(), finished_at = now()
    WHERE id = p_run_id AND status IN ('pending', 'running')
      AND materialize_done AND anonymize_done AND summary_done;
$$;

-- p_step: 'materialize' | 'summary'. Returns false if the run is no longer current.
CREATE OR REPLACE FUNCTION public.pipeline_mark_step(p_run_id UUID, p_step TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.pipeline_is_current(p_run_id) THEN
        RETURN false;
    END IF;
    UPDATE public.case_pipeline_runs
    SET materialize_done = materialize_done OR p_step = 'materialize',
        summary_done = summary_done OR p_step = 'summary',
        updated_at = now()
    WHERE id = p_run_id;
    PERFORM public._complete_run_if_done(p_run_id);
    RETURN true;
END;
$$;

-- VMTB-OCR2ANO-V2 finished anonymizing everything under the request's data/
-- folder as of p_started_at. It doesn't carry a run id (it's started by the
-- GCP OCR job), so it completes the anonymize step of every upload run that
-- existed when it started. report_status only becomes ready once no newer
-- upload run is still waiting to be anonymized.
CREATE OR REPLACE FUNCTION public.pipeline_mark_anonymized(p_request_id TEXT, p_started_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_case_id UUID;
    r RECORD;
BEGIN
    SELECT id INTO v_case_id FROM public.cases WHERE request_id = p_request_id;
    IF v_case_id IS NULL THEN
        RETURN;
    END IF;

    FOR r IN
        UPDATE public.case_pipeline_runs
        SET anonymize_done = true, updated_at = now()
        WHERE case_id = v_case_id AND has_uploads AND NOT anonymize_done
          AND status IN ('pending', 'running') AND created_at <= p_started_at
        RETURNING id
    LOOP
        PERFORM public._complete_run_if_done(r.id);
    END LOOP;

    -- Runs with no run record at all (cases created before this migration)
    -- keep the old behaviour.
    UPDATE public.cases
    SET report_status = 'verified'
    WHERE id = v_case_id
      AND NOT EXISTS (SELECT 1 FROM public.case_pipeline_runs
                      WHERE case_id = v_case_id AND has_uploads AND NOT anonymize_done
                        AND status IN ('pending', 'running'));
END;
$$;

-- Write a run's summary — only if it is still the case's current generation.
-- Returns true if written. patient_age/sex only overwrite when extracted (a
-- null never erases a value the owner entered).
CREATE OR REPLACE FUNCTION public.pipeline_write_summary(
    p_run_id UUID,
    p_summary TEXT,
    p_patient_age INTEGER,
    p_patient_sex TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.case_pipeline_runs;
    v_written INTEGER;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_run_id FOR UPDATE;
    IF v_run.id IS NULL OR v_run.status NOT IN ('pending', 'running') THEN
        RETURN false;
    END IF;

    UPDATE public.cases
    SET summary = p_summary,
        ai_generated_summary = p_summary,
        patient_age = coalesce(p_patient_age, patient_age),
        patient_sex = coalesce(p_patient_sex, patient_sex),
        summary_status = 'unverified',
        summary_generation = v_run.generation
    WHERE id = v_run.case_id AND content_generation = v_run.generation;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    IF v_written = 0 THEN
        UPDATE public.case_pipeline_runs SET status = 'superseded', updated_at = now(), finished_at = now()
        WHERE id = p_run_id;
        RETURN false;
    END IF;

    UPDATE public.case_pipeline_runs SET summary_done = true, updated_at = now() WHERE id = p_run_id;
    PERFORM public._complete_run_if_done(p_run_id);
    RETURN true;
END;
$$;

-- A run step failed. If the run is still current, the case shows the failure
-- (summary_status 'failed') and the owner gets Retry; a superseded run's
-- failure is irrelevant and recorded as superseded.
CREATE OR REPLACE FUNCTION public.pipeline_fail(p_run_id UUID, p_error_code TEXT, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.case_pipeline_runs;
    v_written INTEGER;
BEGIN
    SELECT * INTO v_run FROM public.case_pipeline_runs WHERE id = p_run_id FOR UPDATE;
    IF v_run.id IS NULL OR v_run.status NOT IN ('pending', 'running') THEN
        RETURN false;
    END IF;

    UPDATE public.cases SET summary_status = 'failed'
    WHERE id = v_run.case_id AND content_generation = v_run.generation;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    UPDATE public.case_pipeline_runs
    SET status = CASE WHEN v_written = 0 THEN 'superseded' ELSE 'failed' END,
        error_code = CASE WHEN v_written = 0 THEN NULL ELSE left(p_error_code, 64) END,
        error = CASE WHEN v_written = 0 THEN NULL ELSE left(p_error, 1000) END,
        updated_at = now(), finished_at = now()
    WHERE id = p_run_id;
    RETURN v_written > 0;
END;
$$;

-- ============================================================================
-- Grants
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.document_key(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_case_edits(UUID, UUID, JSONB, TEXT[], JSONB, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_regeneration(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_initial_run(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_case_run(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_case_summary(UUID, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_case_summary_edit(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_case_run_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pipeline_begin(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_is_current(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_mark_step(UUID, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_mark_anonymized(TEXT, TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_write_summary(UUID, TEXT, INTEGER, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_fail(UUID, TEXT, TEXT) TO anon, authenticated, service_role;

-- Internal helpers are not part of the API.
REVOKE ALL ON FUNCTION public._supersede_active_runs(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lock_owned_case(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._expire_stale_runs(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._complete_run_if_done(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._run_json(public.case_pipeline_runs, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- The old cap RPC is replaced by start_regeneration(); keep it callable only
-- until the frontend that uses it is deployed, then drop in a follow-up.
