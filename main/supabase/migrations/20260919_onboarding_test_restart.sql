-- TEMPORARY, for testing the first-time walkthrough. Remove together with the
-- one call in src/context/OnboardingContext.tsx (search "TEMPORARY") by
-- running the drop statements at the bottom of this file.
--
-- A profile with onboarding_test_restart = true gets the walkthrough from the
-- start on every new login. It's keyed on auth.users.last_sign_in_at, which
-- changes on a real sign-in (password or OTP) but not on a page refresh or a
-- token refresh, so progress holds within one logged-in session.
--
-- The flag is only ever set by hand in SQL. A user could set it on their own
-- row through the own-row UPDATE policy, but that only replays their own tour.
alter table public.profiles
  add column if not exists onboarding_test_restart boolean not null default false,
  add column if not exists onboarding_test_reset_for timestamptz;

comment on column public.profiles.onboarding_test_restart is
  'TEMPORARY (testing): restart the walkthrough on every new login.';
comment on column public.profiles.onboarding_test_reset_for is
  'TEMPORARY (testing): the sign-in the walkthrough was last restarted for.';

-- Restarts the caller's walkthrough once per sign-in when their profile is
-- flagged. Returns true when it did. SECURITY DEFINER only to read the
-- caller's own last_sign_in_at from auth.users; it touches only auth.uid()'s
-- row.
create or replace function public.onboarding_test_restart_if_new_sign_in()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sign_in timestamptz;
begin
  select u.last_sign_in_at into v_sign_in from auth.users u where u.id = auth.uid();
  if v_sign_in is null then
    return false;
  end if;
  update public.profiles p
     set onboarding_seen = '{}'::jsonb,
         onboarding_ended_at = null,
         onboarding_test_reset_for = v_sign_in
   where p.id = auth.uid()
     and p.onboarding_test_restart
     and p.onboarding_test_reset_for is distinct from v_sign_in;
  return found;
end;
$$;

revoke all on function public.onboarding_test_restart_if_new_sign_in() from public, anon;
grant execute on function public.onboarding_test_restart_if_new_sign_in() to authenticated;

-- To remove:
--   drop function if exists public.onboarding_test_restart_if_new_sign_in();
--   alter table public.profiles drop column if exists onboarding_test_restart,
--                               drop column if exists onboarding_test_reset_for;
