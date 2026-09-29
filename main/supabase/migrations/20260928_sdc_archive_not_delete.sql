-- Site Data Coordinators may archive a case but not delete one.
--
-- Two separate problems, in opposite directions:
--
-- 1. Archiving was silently broken for them. archive_case() matches on
--    `owner_id = auth.uid()`, but a coordinator's auth.uid() is never the
--    owner -- the owner is the clinician they act for. No row matched, the
--    function returned an empty set, and CasesContext surfaced it as "Only
--    the owner can archive this case". Same actor-vs-owner mistake that
--    20260927_effective_owner_id_rls.sql fixed in the RLS policies, so it
--    takes the same fix: compare against effective_owner_id().
--
-- 2. Deleting was permitted. deleteCase() only checks owner_id against the
--    *effective* owner, which a coordinator satisfies, so nothing stopped
--    them destroying the clinician's case. Hiding the button is not enough:
--    RLS is off on public.cases, so a direct API call would still go
--    through. A BEFORE DELETE trigger enforces it regardless of RLS.

-- Unchanged except for the owner comparison.
CREATE OR REPLACE FUNCTION public.archive_case(p_case_id uuid)
RETURNS SETOF public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_case public.cases;
BEGIN
    UPDATE public.cases
    SET archived_at = now()
    WHERE id = p_case_id
      AND owner_id = public.effective_owner_id()
      AND archived_at IS NULL
    RETURNING * INTO v_case;

    IF v_case.id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM public.mtb_cases WHERE case_id = p_case_id;

    RETURN NEXT v_case;
END;
$function$;

-- A trigger rather than an RLS policy: RLS is disabled on public.cases, so a
-- DELETE policy would never be evaluated. auth.uid() is NULL for the service
-- role and for the document-pipeline Lambdas, so this only ever fires for a
-- real signed-in coordinator, never for backend cleanup.
CREATE OR REPLACE FUNCTION public.enforce_case_delete_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'site_data_coordinator'
  ) THEN
    RAISE EXCEPTION 'Site Data Coordinators cannot delete a case';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cases_delete_role ON public.cases;
CREATE TRIGGER trg_cases_delete_role
  BEFORE DELETE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_case_delete_role();

-- Note on scope: deleteCase() removes case_opinions / case_questions /
-- case_documents / mtb_cases rows before deleting the case, and this trigger
-- does not block those. That is deliberate -- RLS is off on those tables for
-- every role, so any authenticated user can already delete them directly
-- (a standing finding in docs/LEGACY_AND_KNOWN_ISSUES.md). Adding
-- coordinator-only blocks there would be theatre while that hole is open, and
-- would risk breaking the coordinator's legitimate document-editing and
-- remove-from-MTB flows. The case row itself -- the irreversible act the
-- Danger zone warns about -- is what this protects.
