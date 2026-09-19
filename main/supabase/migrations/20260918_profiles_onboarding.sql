-- First-time walkthrough state, per user (see docs/CASE_AND_MTB_WORKFLOW.md,
-- "Onboarding walkthrough"). Not security-critical: it relies on the existing
-- own-row UPDATE policies on profiles, and other users being able to read it
-- through the permissive SELECT policy is harmless.
alter table public.profiles
  add column if not exists onboarding_seen jsonb not null default '{}'::jsonb,
  add column if not exists onboarding_ended_at timestamptz;

comment on column public.profiles.onboarding_seen is
  'Walkthrough parts the user has finished or closed: {"<part id>": "<timestamp>"}.';
comment on column public.profiles.onboarding_ended_at is
  'Set when the walkthrough is over for this user: they stopped it, saw every part, or the account predates it. NULL = still active.';

-- Accounts that predate the walkthrough never see it.
update public.profiles set onboarding_ended_at = now() where onboarding_ended_at is null;

-- Merges one part into onboarding_seen, so two tabs marking different parts
-- can't overwrite each other. SECURITY INVOKER: profiles RLS still applies.
create or replace function public.mark_onboarding_seen(p_key text)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.profiles
     set onboarding_seen = onboarding_seen || jsonb_build_object(p_key, now())
   where id = auth.uid();
$$;

grant execute on function public.mark_onboarding_seen(text) to authenticated;
