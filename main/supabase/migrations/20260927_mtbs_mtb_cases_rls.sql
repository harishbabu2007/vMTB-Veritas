-- Blocks MTB Expert accounts from creating MTBs or adding cases to one,
-- even via a direct Supabase client call bypassing the UI.
--
-- Neither table has a full set of policies matching what the app actually
-- does today (see the comments on each policy below), so this migration
-- first brings RLS up to parity with current behavior, then layers the new
-- restriction on top as a RESTRICTIVE policy -- otherwise enabling RLS here
-- would silently break existing operations for every user, not just the
-- newly-restricted role.

ALTER TABLE public.mtbs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtb_cases ENABLE ROW LEVEL SECURITY;

-- mtbs already has dormant SELECT ("Users can view all MTBs" USING(true))
-- and INSERT ("Users can insert their own MTB" WITH CHECK auth.uid()=owner_id)
-- policies from 20260801155807_remote_schema.sql that match current
-- behavior as-is and become active once RLS is enabled.

-- mtbs has no UPDATE policy anywhere, yet updateMTBName/updateMTBNotification
-- (CasesContext.tsx) both perform real UPDATEs -- without this, RLS-on would
-- silently break MTB rename/notification-toggle for every user.
CREATE POLICY "MTB owner can update their MTB" ON public.mtbs
  FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- The new restriction on Create MTB.
CREATE POLICY "MTB expert cannot create MTBs" ON public.mtbs
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'mtb_expert')
  );

-- mtb_cases's existing dormant SELECT policy ("MTB members can view MTB
-- cases") excludes the MTB owner entirely (owners are never inserted into
-- mtb_members -- see createMTB), which would break every owner's own case
-- list the moment RLS turns on. Add an owner-inclusive SELECT policy
-- alongside it (multiple permissive SELECT policies OR together, so this
-- only adds coverage, it doesn't replace the existing one).
CREATE POLICY "MTB owner can view own MTB cases" ON public.mtb_cases
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.mtbs WHERE mtbs.id = mtb_cases.mtb_id AND mtbs.owner_id = auth.uid())
  );

-- The existing dormant INSERT policy ("MTB owner can add cases to MTB",
-- owner-only) doesn't match actual app behavior: addCaseToMTB/addCaseToMTBs
-- are called by any case owner adding their case to any MTB they're a
-- member OR owner of, with zero server-side ownership check today. Reusing
-- the dormant owner-only policy as-is would newly break "add my case to an
-- MTB I'm a member of but don't own" for every regular member, not just
-- mtb_expert -- so it's replaced with a policy matching today's actual
-- (wide-open) behavior, restricted only by the new mtb_expert-blocking
-- RESTRICTIVE policy below.
DROP POLICY IF EXISTS "MTB owner can add cases to MTB" ON public.mtb_cases;
CREATE POLICY "Any authenticated user can add a case to MTB" ON public.mtb_cases
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "MTB expert cannot add cases to MTB" ON public.mtb_cases
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'mtb_expert')
  );

-- mtb_cases has no DELETE policy; removeCaseFromMTB and deleteCase's
-- cleanup delete with zero ownership check today. Matching that exact
-- (wide-open) status quo, not tightening it -- tightening mtb_cases
-- deletes is out of scope for this feature.
CREATE POLICY "Any authenticated user can remove a case from MTB" ON public.mtb_cases
  FOR DELETE USING (auth.uid() IS NOT NULL);
