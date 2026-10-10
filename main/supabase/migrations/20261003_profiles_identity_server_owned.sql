-- Make the identity columns server-owned, and take the OTP table away from
-- clients entirely.
--
-- Why
-- ---
-- `profiles.role` and `profiles.linked_clinician_id` are the whole basis of
-- who a request acts as: `effective_owner_id()` returns
-- COALESCE(linked_clinician_id, id), and every owner check in the database
-- (`_lock_owned_case`, `archive_case`, the policies added in
-- 20260927_effective_owner_id_rls.sql) trusts it. `RoleRoute` in the frontend
-- trusts `role`. So these two columns decide which clinician's cases a
-- session can reach.
--
-- They were writable by the client. `authenticated` held UPDATE on every
-- column of `profiles` (and so did `anon`), under a policy of
-- `auth.uid() = id`. The existing `enforce_profile_role_immutable` trigger
-- locked `role`/`linked_clinician_id` only while the row already had
-- `whatsapp_verified = true` -- and `whatsapp_verified` was in that same
-- writable set, as was `whatsapp_number`. A column that gates its own guard
-- is not a guard.
--
-- `whatsapp_otps` had the same shape: full CRUD for `anon` and
-- `authenticated`, with policies scoped by the caller's own
-- `profiles.whatsapp_number`. Only `verify_whatsapp_otp` (service-role)
-- has any business touching it.
--
-- What this does
--   1. Column-level INSERT/UPDATE grants on `profiles`: clients may write
--      only their display, preference and onboarding fields.
--   2. A trigger that makes the four identity columns server-only, and keeps
--      the existing post-registration immutability.
--   3. Revokes every client privilege on `whatsapp_otps` and drops its
--      policies. RLS stays on with no policies; service_role bypasses RLS.
--
-- Paired client changes (same commit): the `whatsapp_number` writes are
-- removed from AuthContext's two upserts and from VerifyWhatsApp, which were
-- the only client paths touching a now-server-owned column.
--
-- Rollback: 20261003_profiles_identity_server_owned_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. profiles: column-level write grants
-- ---------------------------------------------------------------------------

-- Blanket table-level grants are what made every column writable; replace
-- them with an explicit column list. `anon` keeps no write privilege at all --
-- profile rows are only ever created by a signed-in session or by the
-- service-role Edge Function.
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon;
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;

-- Creating your own row: AuthContext's post-sign-in upsert and
-- ThemeContext's fallback upsert. Note `whatsapp_number` is deliberately
-- absent -- it is set by verify_whatsapp_otp once an OTP has actually been
-- checked, never from the browser.
GRANT INSERT (id, full_name, profession, hospital, theme_preference)
    ON public.profiles TO authenticated;

-- Editing your own row: the Settings panel (full_name/profession/hospital/
-- updated_at), the avatar upload (avatar_key), the theme toggle
-- (theme_preference) and the onboarding tour (onboarding_seen,
-- onboarding_ended_at -- also written by the SECURITY INVOKER RPC
-- mark_onboarding_seen, which runs as the caller and so relies on this grant).
--
-- `id` is listed because supabase-js upserts (AuthContext's two, ThemeContext's
-- fallback) become `INSERT ... ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id,
-- ...`: PostgREST puts every payload column in the SET list, so the update half
-- needs UPDATE on `id` too. Granting it changes nothing in practice --
-- profiles_update_own's WITH CHECK (id = auth.uid()) still refuses any row
-- whose id is not the caller's own.
GRANT UPDATE (
    id,
    full_name,
    profession,
    hospital,
    avatar_key,
    theme_preference,
    onboarding_seen,
    onboarding_ended_at,
    updated_at
) ON public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. profiles: the identity-column guard
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER (the default) is load-bearing here: inside a SECURITY
-- DEFINER function `current_user` is the function's owner, not the role
-- PostgREST switched to, so the client/server test below would always read
-- "server" and the guard would never fire.
CREATE OR REPLACE FUNCTION public.profiles_guard_identity_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    -- The roles PostgREST and the Edge Functions connect as. Anything else
    -- is a browser session.
    v_is_server BOOLEAN := current_user IN ('service_role', 'postgres', 'supabase_admin');
BEGIN
    IF NOT v_is_server THEN
        IF TG_OP = 'INSERT' THEN
            -- A client may create its own profile row, but never arrive
            -- pre-verified or pre-linked. These are forced rather than
            -- rejected because the legitimate signup upserts do not set them
            -- at all, so forcing keeps those paths working while making a
            -- crafted payload inert. The values match the column defaults and
            -- satisfy profiles_linked_clinician_id_role_check (a clinician
            -- must have a NULL link).
            NEW.role := 'clinician';
            NEW.linked_clinician_id := NULL;
            NEW.whatsapp_verified := false;
            NEW.whatsapp_number := NULL;
            RETURN NEW;
        END IF;

        IF NEW.role              IS DISTINCT FROM OLD.role
        OR NEW.linked_clinician_id IS DISTINCT FROM OLD.linked_clinician_id
        OR NEW.whatsapp_verified IS DISTINCT FROM OLD.whatsapp_verified
        OR NEW.whatsapp_number   IS DISTINCT FROM OLD.whatsapp_number THEN
            RAISE EXCEPTION
                'profiles: role, linked_clinician_id, whatsapp_number and whatsapp_verified are set server-side only'
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    -- Server-side writers: keep the guarantee the previous trigger provided,
    -- that registration fixes the account's role for good. verify_whatsapp_otp
    -- sets role/linked_clinician_id in the same upsert that first flips
    -- whatsapp_verified to true, so OLD.whatsapp_verified is still false at
    -- that point and this does not block it. A later WhatsApp-number change
    -- sends no role, so it does not trip either.
    IF TG_OP = 'UPDATE' AND OLD.whatsapp_verified IS TRUE THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'role cannot be changed once registration is complete';
        END IF;
        IF NEW.linked_clinician_id IS DISTINCT FROM OLD.linked_clinician_id THEN
            RAISE EXCEPTION 'linked_clinician_id cannot be changed once registration is complete';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.profiles_guard_identity_columns() IS
    'Keeps role, linked_clinician_id, whatsapp_number and whatsapp_verified server-owned: forced to safe values on a client INSERT, rejected on a client UPDATE, and role/link still frozen once whatsapp_verified is true. Must stay SECURITY INVOKER so current_user is the caller.';

-- Replaces trg_profiles_role_immutable (20260927_profiles_access_role.sql),
-- which covered UPDATE only and keyed off a client-writable column.
DROP TRIGGER IF EXISTS trg_profiles_role_immutable ON public.profiles;
DROP TRIGGER IF EXISTS trg_profiles_guard_identity_columns ON public.profiles;
CREATE TRIGGER trg_profiles_guard_identity_columns
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_identity_columns();

DROP FUNCTION IF EXISTS public.enforce_profile_role_immutable();

-- ---------------------------------------------------------------------------
-- 3. whatsapp_otps: server-side only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS whatsapp_otps_select_own_phone ON public.whatsapp_otps;
DROP POLICY IF EXISTS whatsapp_otps_insert_own_phone ON public.whatsapp_otps;
DROP POLICY IF EXISTS whatsapp_otps_update_own_phone ON public.whatsapp_otps;
DROP POLICY IF EXISTS whatsapp_otps_delete_own_phone ON public.whatsapp_otps;

REVOKE ALL ON public.whatsapp_otps FROM anon, authenticated;
GRANT  ALL ON public.whatsapp_otps TO service_role;

-- Already enabled; restated so the table's protection is readable in one
-- place. With no policies and no client grants, the only way in is the
-- service-role key.
ALTER TABLE public.whatsapp_otps ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.whatsapp_otps IS
    'OTP issuance and verification state. Written only by the send_whatsapp_otp / verify_whatsapp_otp Edge Functions with the service-role key: RLS is on with zero policies and clients hold no privileges. Do not grant anon or authenticated access -- the rate limit, attempt counter and single-use claim in those functions are only meaningful if clients cannot edit the rows.';
