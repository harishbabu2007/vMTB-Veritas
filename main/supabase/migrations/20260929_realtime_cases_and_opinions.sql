-- Adds `cases` and `case_opinions` to the supabase_realtime publication, so
-- that the postgres_changes subscriptions in CasesContext.tsx (cases,
-- filtered owner_id=eq.<effectiveOwnerId>) and ViewCase.tsx (case_opinions,
-- filtered case_id=eq.<id>) actually receive change events. Without this,
-- that client-side code subscribes successfully but silently never fires --
-- ALTER PUBLICATION is what turns on logical replication for a table.
--
-- Security note (see docs/DATABASE_SCHEMA.md's RLS section, and the code
-- comments at both call sites above): `cases` has RLS off and
-- `case_opinions`'s SELECT policy is `USING (true)` -- neither subscription
-- is enforcing anything Realtime itself doesn't already allow; both are
-- exactly as open as a direct REST read of the same tables already is today.
-- This migration doesn't change that standing, separately-tracked posture,
-- it only turns on the replication feed those two tables didn't have yet.
--
-- Idempotent: adding a table to the publication a second time is a no-op.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'cases'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.cases;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'case_opinions'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.case_opinions;
    END IF;
END
$$;
