-- Fixes a regression introduced by 20260927_mtbs_mtb_cases_rls.sql (and the
-- same latent mistake in 20260927_case_opinions_questions_rls.sql).
--
-- Those migrations enabled RLS on tables whose policies encode "the actor is
-- the owner" (auth.uid() = owner_id). That assumption breaks the Site Data
-- Coordinator role, whose entire purpose is that the actor and the owner are
-- different accounts: CasesContext writes owner_id = effectiveOwnerId (the
-- linked clinician) while auth.uid() is the coordinator. With no server-side
-- counterpart to effectiveOwnerId, those policies reject every SDC write to
-- mtbs and hide the clinician's mtb_cases rows from them:
--
--   * mtbs INSERT  -> createMTB rejected (42501); Create MTB never works.
--   * mtbs UPDATE  -> updateMTBName/updateMTBNotification match 0 rows and
--                     fail silently; a rename appears to work, then reverts.
--   * mtb_cases SELECT -> the coordinator sees the MTB but none of its cases.
--
-- effective_owner_id() is the SQL mirror of AuthContext's
-- `role === 'site_data_coordinator' ? linkedClinicianId : user.id`. COALESCE
-- is exact rather than a shortcut: profiles_linked_clinician_id_role_check
-- already guarantees linked_clinician_id is non-null iff role is
-- 'site_data_coordinator', and null for every other role.

CREATE OR REPLACE FUNCTION public.effective_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(p.linked_clinician_id, p.id)
  FROM public.profiles p
  WHERE p.id = auth.uid();
$$;

-- Called as `(SELECT public.effective_owner_id())` in every policy below:
-- wrapping it in a scalar subquery gets it evaluated once per statement
-- instead of once per row (the same reason Supabase recommends
-- `(SELECT auth.uid())` in policies).

-- --------------------------------------------------------------------------
-- mtbs
-- --------------------------------------------------------------------------

-- Replaces the dormant baseline policy from 20260801155807_remote_schema.sql,
-- which only became active when RLS was switched on earlier today.
DROP POLICY IF EXISTS "Users can insert their own MTB" ON public.mtbs;
CREATE POLICY "Owner or their coordinator can insert MTB" ON public.mtbs
  FOR INSERT
  WITH CHECK (owner_id = (SELECT public.effective_owner_id()));

DROP POLICY IF EXISTS "MTB owner can update their MTB" ON public.mtbs;
CREATE POLICY "MTB owner can update their MTB" ON public.mtbs
  FOR UPDATE
  USING (owner_id = (SELECT public.effective_owner_id()))
  WITH CHECK (owner_id = (SELECT public.effective_owner_id()));

-- --------------------------------------------------------------------------
-- mtb_cases
-- --------------------------------------------------------------------------

-- The companion "MTB members can view MTB cases" policy is deliberately left
-- on auth.uid(): membership is personal, not delegated, which is the same
-- distinction the client draws between ownUserId and effectiveOwnerId in
-- joinMTB/leaveMTB. A coordinator who joins a board by invite code is a
-- member in their own right, not on the clinician's behalf.
DROP POLICY IF EXISTS "MTB owner can view own MTB cases" ON public.mtb_cases;
CREATE POLICY "MTB owner can view own MTB cases" ON public.mtb_cases
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.mtbs
      WHERE mtbs.id = mtb_cases.mtb_id
        AND mtbs.owner_id = (SELECT public.effective_owner_id())
    )
  );

-- --------------------------------------------------------------------------
-- case_opinions / case_questions
-- --------------------------------------------------------------------------

-- Not a live bug today (an SDC has no Opinions tab at all, so neither delete
-- is reachable for that role), but corrected here so every owner-scoped
-- policy in this schema means the same thing by "owner" -- otherwise the next
-- person has to re-derive which policies are actor-scoped and which are
-- owner-scoped.
DROP POLICY IF EXISTS "Case owner can delete case opinions" ON public.case_opinions;
CREATE POLICY "Case owner can delete case opinions" ON public.case_opinions
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.cases
      WHERE cases.id = case_opinions.case_id
        AND cases.owner_id = (SELECT public.effective_owner_id())
    )
  );

DROP POLICY IF EXISTS "Case owner can delete case questions" ON public.case_questions;
CREATE POLICY "Case owner can delete case questions" ON public.case_questions
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.cases
      WHERE cases.id = case_questions.case_id
        AND cases.owner_id = (SELECT public.effective_owner_id())
    )
  );

-- The four RESTRICTIVE role-blocking policies (SDC cannot post opinions / add
-- questions, MTB expert cannot create MTBs / add cases to MTB) are unchanged
-- and stay on auth.uid(). They ask "who is acting", which genuinely is the
-- signed-in user, not the account being acted for.
