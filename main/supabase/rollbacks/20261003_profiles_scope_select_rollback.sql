-- Rollback for 20261003_profiles_scope_select.sql.
--
-- Restores world-readable `profiles`. That exposes every user's name,
-- profession, hospital, WhatsApp number, role and linked_clinician_id to
-- anyone holding the anon key, so run it only to unblock a broken path, and
-- re-apply the scoping as soon as that path is fixed forward.
--
-- Note the paired migrations are NOT undone by this file: the phone-lookup
-- RPCs and verify_whatsapp_otp's phone-keyed get_email keep working either
-- way, so there is no need to put the browser's cross-user reads back.

BEGIN;

GRANT SELECT ON public.profiles TO anon;

CREATE POLICY "Users can view all profiles" ON public.profiles
    FOR SELECT
    USING (true);

COMMIT;
