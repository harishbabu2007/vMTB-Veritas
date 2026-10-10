-- Case names: generate them server-side, and make uniqueness real.
--
-- Why
-- ---
-- A case name ("ILC80981" = the cancer type's published abbreviation plus 5
-- digits) is the human-facing identifier for a case. It was generated in the
-- browser, which then read `cases` across every user to see whether the name
-- was already taken (NewCaseStep1.tsx: a `.in(case_name, candidates)` lookup
-- plus an `isCaseNameUnique` single-row check).
--
-- That read only works while `cases` is world-readable. The moment row level
-- security lands on `cases`, those queries still succeed but see only the
-- caller's own rows -- so they would silently stop detecting collisions
-- instead of failing loudly. This migration therefore has to land *before*
-- the RLS work, not after it.
--
-- Two changes:
--   1. `generate_case_name()` does the generate-and-check server-side, so the
--      browser never reads another user's row to pick a name.
--   2. A unique index makes the guarantee real. The old client-side check was
--      advisory only -- there was no constraint, so two sessions could always
--      race to the same name. Verified 2026-10-03: 14 rows, no duplicates and
--      no empty names, so the index builds cleanly.
--
-- Rollback: DROP FUNCTION public.generate_case_name(TEXT);
--           DROP INDEX public.cases_case_name_key;

-- 1. Uniqueness, enforced by the database rather than hoped for by the client.
CREATE UNIQUE INDEX IF NOT EXISTS cases_case_name_key
    ON public.cases (case_name);

-- 2. Server-side name generation.
CREATE OR REPLACE FUNCTION public.generate_case_name(p_abbreviation TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_abbr TEXT := btrim(coalesce(p_abbreviation, ''));
    v_name TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
    END IF;

    -- Abbreviations are kept exactly as published, so the standard forms all
    -- have to survive: "ILC", but also "ccRCC" and "BR-PAGET". Anything else
    -- is rejected rather than concatenated into a name.
    IF v_abbr !~ '^[A-Za-z][A-Za-z0-9-]{0,31}$' THEN
        RAISE EXCEPTION 'INVALID_ABBREVIATION';
    END IF;

    -- 5 digits is 90,000 names per abbreviation, so a free one is found on the
    -- first try in practice. The loop is the collision path, not the norm.
    FOR i IN 1..20 LOOP
        v_name := v_abbr || (10000 + floor(random() * 90000))::INT::TEXT;
        IF NOT EXISTS (SELECT 1 FROM public.cases WHERE case_name = v_name) THEN
            RETURN v_name;
        END IF;
    END LOOP;

    -- An abbreviation this crowded is not a case we expect to reach, but
    -- widening the suffix is better than handing back a name that is taken.
    FOR i IN 1..20 LOOP
        v_name := v_abbr || (1000000 + floor(random() * 9000000))::INT::TEXT;
        IF NOT EXISTS (SELECT 1 FROM public.cases WHERE case_name = v_name) THEN
            RETURN v_name;
        END IF;
    END LOOP;

    RAISE EXCEPTION 'CASE_NAME_EXHAUSTED';
END;
$$;

COMMENT ON FUNCTION public.generate_case_name(TEXT) IS
    'Returns an unused case name for a cancer-type abbreviation. Exists so the browser never has to read other users'' cases rows to check a name; cases_case_name_key is what actually enforces uniqueness.';

-- Signed-in callers only. A bare GRANT would leave the default PUBLIC execute
-- grant in place, which is how anon reaches a SECURITY DEFINER function --
-- revoke it explicitly, same pattern as
-- 20261001_meeting_participant_identity.sql.
REVOKE EXECUTE ON FUNCTION public.generate_case_name(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.generate_case_name(TEXT) TO authenticated;
