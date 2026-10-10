-- Move the two cross-user phone lookups out of the browser.
--
-- Why
-- ---
-- Signup and login both have to answer questions about accounts that are not
-- the caller's own:
--   * "is this WhatsApp number already registered?" (both forms)
--   * "which verified clinician does this number belong to?" (Site Data
--     Coordinator signup)
--
-- Both were answered by the browser reading `profiles` directly, filtered by
-- phone number. That only works because `profiles` currently carries a
-- `SELECT USING (true)` policy granted to `public`, which also means every
-- clinician's name, hospital and WhatsApp number is readable by anyone with
-- the anon key. Scoping that policy is the point of the next migration, and
-- it would break these two paths -- so they move server-side first.
--
-- Both are for signed-in callers only. Signup runs after Google OAuth, so a
-- session already exists when either is called. The login form needs no
-- lookup of its own: send_whatsapp_otp (purpose 'login') and
-- verify_whatsapp_otp (get_email) answer "is this number registered?"
-- server-side, behind the Edge Functions' rate limits. Granting these to anon
-- would make them a free, unthrottled directory of registered numbers. Each
-- answers only the one narrow question it has to, and neither returns a row
-- from `profiles`.
--
-- The filters are also parameterised rather than built by string
-- concatenation. The browser versions interpolated the number straight into a
-- PostgREST `.or()` expression, which is filter syntax, not a value.
--
-- Rollback: DROP FUNCTION public.phone_number_registered(TEXT, UUID);
--           DROP FUNCTION public.find_clinician_by_phone(TEXT);

-- Shared normalisation: numbers are typed and stored in several shapes
-- ("+91 99...", "9199..."), so a lookup has to consider the variants.
CREATE OR REPLACE FUNCTION public.phone_variants(p_phone TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN coalesce(regexp_replace(p_phone, '\D', '', 'g'), '') = '' THEN '{}'::TEXT[]
        ELSE ARRAY[
            regexp_replace(p_phone, '\D', '', 'g'),
            '+' || regexp_replace(p_phone, '\D', '', 'g')
        ]
    END;
$$;

REVOKE EXECUTE ON FUNCTION public.phone_variants(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.phone_variants(TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- "Is this number already taken?"
-- ---------------------------------------------------------------------------
-- Returns a boolean and nothing else. This is deliberately an existence
-- oracle -- the signup form's whole job here is to say "that number is
-- already registered" -- but it no longer comes with the profile row, the
-- account id, or the ability to read the table.
CREATE OR REPLACE FUNCTION public.phone_number_registered(
    p_phone TEXT,
    p_exclude_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.whatsapp_number = ANY (public.phone_variants(p_phone))
          AND (p_exclude_user_id IS NULL OR p.id <> p_exclude_user_id)
    );
$$;

COMMENT ON FUNCTION public.phone_number_registered(TEXT, UUID) IS
    'True when some profile already holds this WhatsApp number. Replaces a direct browser read of profiles on the signup form (signed-in callers only); returns no row data.';

REVOKE EXECUTE ON FUNCTION public.phone_number_registered(TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.phone_number_registered(TEXT, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- "Which clinician is this?"
-- ---------------------------------------------------------------------------
-- Used once, at Site Data Coordinator signup, to turn the clinician's phone
-- number into the id stored in profiles.linked_clinician_id. Returns the id
-- and display name only for a unique, verified clinician, and otherwise a
-- reason the form can show. The reasons match the previous client-side
-- helper so the signup messages are unchanged.
--
-- Note it returns the resolved id rather than the phone number, so a later
-- number change on the clinician's account cannot retroactively redirect an
-- established link.
CREATE OR REPLACE FUNCTION public.find_clinician_by_phone(p_phone TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_variants TEXT[] := public.phone_variants(p_phone);
    v_count    INTEGER;
    v_row      public.profiles;
BEGIN
    IF cardinality(v_variants) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    SELECT count(*) INTO v_count
    FROM public.profiles p
    WHERE p.whatsapp_number = ANY (v_variants);

    IF v_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    -- The same number can legitimately be stored in two formats, which is
    -- why this is a count rather than a single-row fetch.
    IF v_count > 1 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'ambiguous');
    END IF;

    SELECT * INTO v_row
    FROM public.profiles p
    WHERE p.whatsapp_number = ANY (v_variants);

    IF v_row.role IS DISTINCT FROM 'clinician' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_clinician');
    END IF;

    IF v_row.whatsapp_verified IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unverified');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_row.id,
        'full_name', v_row.full_name
    );
END;
$$;

COMMENT ON FUNCTION public.find_clinician_by_phone(TEXT) IS
    'Resolves a phone number to a unique verified clinician for Site Data Coordinator signup, returning {ok,id,full_name} or {ok:false,reason}. Replaces a direct browser read of profiles.';

REVOKE EXECUTE ON FUNCTION public.find_clinician_by_phone(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.find_clinician_by_phone(TEXT) TO authenticated;
