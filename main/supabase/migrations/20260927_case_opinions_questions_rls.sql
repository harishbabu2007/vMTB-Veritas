-- Blocks Site Data Coordinator accounts from posting opinions or questions,
-- even via a direct Supabase client call bypassing the UI.
--
-- case_opinions/case_questions have existing dormant SELECT/INSERT policies
-- (from 20260801155807_remote_schema.sql) that already match current app
-- behavior; they become active as-is once RLS is enabled below. Neither
-- table has an UPDATE/DELETE policy today, so matching ones are added
-- first (mirroring exactly what the app already does: deleteCase's
-- owner-checked cascade, and the currently-unused updateOpinion) --
-- otherwise enabling RLS here would silently break those operations for
-- every user, not just the newly-restricted role.

ALTER TABLE public.case_opinions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Case owner can delete case opinions" ON public.case_opinions
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.cases WHERE cases.id = case_opinions.case_id AND cases.owner_id = auth.uid())
  );

CREATE POLICY "Case owner can delete case questions" ON public.case_questions
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.cases WHERE cases.id = case_questions.case_id AND cases.owner_id = auth.uid())
  );

CREATE POLICY "Author can update own opinion" ON public.case_opinions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- The new restriction: a site_data_coordinator may never INSERT into either
-- table. RESTRICTIVE so it subtracts from (rather than replaces) the
-- permissive INSERT policies above -- the only way to express "block this
-- one role" without reopening the policy design for everyone else.
CREATE POLICY "SDC cannot post opinions" ON public.case_opinions
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'site_data_coordinator')
  );

CREATE POLICY "SDC cannot add questions" ON public.case_questions
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'site_data_coordinator')
  );
