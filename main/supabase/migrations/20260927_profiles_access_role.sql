-- Adds role-based access (clinician / site_data_coordinator / mtb_expert)
-- to profiles, plus an SDC's link back to the clinician whose cases/MTBs
-- they act on behalf of.
--
-- Immutability: role and linked_clinician_id may freely change ONLY while
-- an account's registration is still in flight (profiles.whatsapp_verified
-- = false, e.g. the bare row backfillProfileFromMetadata() creates from
-- Google user_metadata before the WhatsApp OTP step runs). The moment
-- whatsapp_verified flips true (verify_whatsapp_otp Edge Function), the
-- account is "fully registered" and role/linked_clinician_id are locked
-- forever -- no UPDATE, from any code path, may change them again.
--
-- Why anchor on whatsapp_verified rather than "column is non-null": the
-- column has a NOT NULL DEFAULT, so it is non-null from the very first
-- backfill insert, before the user has made a real choice. whatsapp_verified
-- is the one column that is false during that entire window and is flipped
-- server-side exactly once, at the moment registration completes.

ALTER TABLE public.profiles
  ADD COLUMN role text NOT NULL DEFAULT 'clinician',
  ADD COLUMN linked_clinician_id uuid REFERENCES public.profiles(id);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('clinician', 'site_data_coordinator', 'mtb_expert'));

-- linked_clinician_id only makes sense for an SDC, and can never point at
-- the row itself.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_linked_clinician_id_role_check
  CHECK (
    (role = 'site_data_coordinator' AND linked_clinician_id IS NOT NULL)
    OR (role <> 'site_data_coordinator' AND linked_clinician_id IS NULL)
  );

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_linked_clinician_id_not_self
  CHECK (linked_clinician_id IS NULL OR linked_clinician_id <> id);

CREATE INDEX idx_profiles_linked_clinician_id
  ON public.profiles (linked_clinician_id);

-- Immutability trigger.
CREATE OR REPLACE FUNCTION public.enforce_profile_role_immutable()
RETURNS trigger
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

DROP TRIGGER IF EXISTS trg_profiles_role_immutable ON public.profiles;
CREATE TRIGGER trg_profiles_role_immutable
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_role_immutable();
