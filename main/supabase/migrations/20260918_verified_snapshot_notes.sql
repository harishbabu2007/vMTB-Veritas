-- Follow-up to 20260918_case_pipeline_runs.sql: the verified snapshot MTB
-- members see while a newer version of a case is unverified also captures the
-- case's "Your data" notes. Notes aren't versioned, so without this, members
-- would see notes edited after verification next to the older, verified
-- summary and documents. Same function bodies as the updated definitions in
-- 20260918_case_pipeline_runs.sql.

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
