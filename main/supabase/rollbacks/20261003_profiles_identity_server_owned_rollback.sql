-- Rollback for 20261003_profiles_identity_server_owned.sql.
--
-- Restores the pre-migration state: blanket table grants on `profiles`, the
-- original `enforce_profile_role_immutable` trigger, and the four
-- `whatsapp_otps` policies with their client grants.
--
-- Only run this if the lock-down broke a path that cannot be fixed forward.
-- It re-opens the identity columns and the OTP table to clients, which is
-- the exposure the migration exists to close -- so treat it as a stopgap and
-- re-apply as soon as the blocking path is fixed.

BEGIN;

-- 1. profiles: back to table-level grants
DROP TRIGGER IF EXISTS trg_profiles_guard_identity_columns ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_guard_identity_columns();

REVOKE INSERT (id, full_name, profession, hospital, theme_preference)
    ON public.profiles FROM authenticated;
REVOKE UPDATE (
    id, full_name, profession, hospital, avatar_key,
    theme_preference, onboarding_seen, onboarding_ended_at, updated_at
) ON public.profiles FROM authenticated;

GRANT INSERT, UPDATE, DELETE ON public.profiles TO anon;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_profile_role_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.whatsapp_verified IS TRUE THEN
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

CREATE TRIGGER trg_profiles_role_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_role_immutable();

-- 2. whatsapp_otps: back to client-accessible
GRANT ALL ON public.whatsapp_otps TO anon, authenticated;

CREATE POLICY whatsapp_otps_select_own_phone ON public.whatsapp_otps
    FOR SELECT TO authenticated
    USING (phone = (SELECT p.whatsapp_number FROM public.profiles p WHERE p.id = auth.uid()));

CREATE POLICY whatsapp_otps_insert_own_phone ON public.whatsapp_otps
    FOR INSERT TO authenticated
    WITH CHECK (phone = (SELECT p.whatsapp_number FROM public.profiles p WHERE p.id = auth.uid()));

CREATE POLICY whatsapp_otps_update_own_phone ON public.whatsapp_otps
    FOR UPDATE TO authenticated
    USING (phone = (SELECT p.whatsapp_number FROM public.profiles p WHERE p.id = auth.uid()))
    WITH CHECK (phone = (SELECT p.whatsapp_number FROM public.profiles p WHERE p.id = auth.uid()));

CREATE POLICY whatsapp_otps_delete_own_phone ON public.whatsapp_otps
    FOR DELETE TO authenticated
    USING (phone = (SELECT p.whatsapp_number FROM public.profiles p WHERE p.id = auth.uid()));

COMMIT;
