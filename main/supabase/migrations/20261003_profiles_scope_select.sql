-- Scope reads of `profiles` to the caller's own row.
--
-- Why
-- ---
-- `profiles` carried a `SELECT USING (true)` policy granted to `public`, so
-- anyone holding the anon key could read every row: full name, profession,
-- hospital, WhatsApp number, role and linked_clinician_id for every user. The
-- anon key ships in the frontend bundle, so "public" here means public.
--
-- That policy existed because three browser paths needed to look up accounts
-- other than their own. All three are now server-side:
--   * the login/signup "is this number taken?" check and the Site Data
--     Coordinator clinician lookup -> phone_number_registered() and
--     find_clinician_by_phone() (20261003_profile_phone_lookup_rpcs.sql)
--   * phone+password login's email resolution -> verify_whatsapp_otp's
--     get_email action, keyed on the phone number
--
-- Everything the app still reads from `profiles` is its own row, filtered by
-- `.eq('id', <own id>)`: AuthContext's profile load, the Settings panel,
-- ThemeContext, OnboardingContext, AuthCallback and Signup's
-- already-verified check. Verified 2026-10-03 by reading every
-- `from('profiles')` call site.
--
-- Nothing displays another user's name: opinions are deliberately anonymised
-- to "Anonymous XX" / "Case Owner" (OpinionComment.tsx), board membership is
-- only ever counted, and an SDC's linked clinician is held as an id. So
-- own-row is the whole requirement. If a feature later needs co-member
-- names, add a narrow policy for shared-board members rather than restoring
-- a blanket one.
--
-- Also drops three legacy duplicate policies granted to `public` that
-- overlap the `authenticated` ones added in 20260927_profiles_access_role.sql.
-- Leaving both meant the permissive `public` copy decided the outcome.
--
-- Rollback: 20261003_profiles_scope_select_rollback.sql

-- The blanket read. This is the one that matters.
DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;

-- Legacy duplicates of profiles_insert_own / profiles_update_own, all granted
-- to `public` (so anon too) rather than `authenticated`.
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- What remains, all TO authenticated and all keyed on id = auth.uid():
--   profiles_select_own, profiles_insert_own, profiles_update_own,
--   profiles_delete_own.
-- Restated here rather than assumed, so applying this file twice is safe and
-- so the surviving set is visible in one place.
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
    FOR SELECT TO authenticated
    USING (id = (SELECT auth.uid()));

-- `anon` has no reason to read the table at all: the pre-sign-in lookups go
-- through SECURITY DEFINER functions, which run as the owner and so are
-- unaffected by this.
REVOKE SELECT ON public.profiles FROM anon;

COMMENT ON TABLE public.profiles IS
    'One row per account. Readable only by its owner: the pre-sign-in and cross-user lookups go through phone_number_registered(), find_clinician_by_phone() and verify_whatsapp_otp instead. role, linked_clinician_id, whatsapp_number and whatsapp_verified are server-owned (trg_profiles_guard_identity_columns); clients may write only display, preference and onboarding columns.';
