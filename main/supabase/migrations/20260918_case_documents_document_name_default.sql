-- Follow-up to 20260918_case_pipeline_runs.sql.
--
-- That migration added case_documents.document_name (the pipeline's name for
-- a document: its file name without extension) and backfilled existing rows,
-- and commit_case_edits() matches removals and redaction edits on it. Rows
-- inserted afterwards by case creation (CasesContext.createCase) don't set it,
-- so without this every new case's documents would be unmatchable — removing
-- one would silently record a separate "removed" row instead. Fill it in on
-- insert, exactly as the backfill did.

CREATE OR REPLACE FUNCTION public._case_documents_set_document_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.document_name IS NULL AND NEW.file_name IS NOT NULL THEN
        NEW.document_name := public.document_key(NEW.file_name);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS case_documents_set_document_name ON public.case_documents;
CREATE TRIGGER case_documents_set_document_name
    BEFORE INSERT ON public.case_documents
    FOR EACH ROW EXECUTE FUNCTION public._case_documents_set_document_name();

UPDATE public.case_documents
SET document_name = public.document_key(file_name)
WHERE document_name IS NULL AND file_name IS NOT NULL;
