-- Publishes the tables the live-update work in CasesContext.tsx / ViewCase.tsx
-- subscribes to. A postgres_changes subscription on an unpublished table
-- reaches SUBSCRIBED and then silently never fires, so the client code added
-- alongside this migration is inert until this is applied.
--
-- Not published here, deliberately: mtb_members, case_documents,
-- case_pipeline_runs, meeting_sessions, profiles. All have RLS off (verified
-- live 2026-09-29), so publishing them would stream every row to any
-- authenticated subscriber, and none of the designs in this pass need them --
-- see docs/DATABASE_SCHEMA.md's RLS section.
--
-- RLS status of what IS published here (verified live 2026-09-29): mtb_cases,
-- mtbs and case_questions all have RLS enabled, so Realtime evaluates each
-- subscriber's SELECT policies per change. That is what makes the unfiltered
-- mtb_cases / mtbs subscriptions safe: the server scopes them, not the client.
--
-- Idempotent: adding a table to the publication a second time is a no-op.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mtb_cases'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.mtb_cases;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mtbs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.mtbs;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'case_questions'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.case_questions;
    END IF;
END
$$;

-- Needed so that "case removed from a board" can be routed to the right
-- board. What FULL buys is narrower than it first appears, so to be precise:
--
--   * realtime.apply_rls() matches a subscription's `filter:` for a DELETE
--     against the OLD row. Under the default identity that row is just the
--     primary key -- a surrogate `id` here -- so an `mtb_id=eq.` filter can
--     never match and the event is not delivered to that subscription. FULL
--     puts mtb_id in the old row, so the filter matches. This is the part
--     that matters.
--   * It does NOT widen the delivered payload. For an RLS-enabled table
--     apply_rls() strips a DELETE's old_record back to primary-key columns
--     ("if RLS enabled, we can't secure deletes so filter to pkey"), so the
--     client still receives only `{id}` and cannot tell which case left.
--     The mtb_id-filtered subscription in MTBDetail.tsx works around that by
--     re-reading the board rather than trusting the payload.
--
-- Safe here: mtb_cases is a narrow two-FK join table, so the extra WAL volume
-- is negligible. Deliberately NOT applied to `cases`, whose rows are wide
-- (they carry the full summary text).
ALTER TABLE public.mtb_cases REPLICA IDENTITY FULL;
