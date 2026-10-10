// supabase/functions/verify_whatsapp_otp/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Phone numbers arrive in whichever shape the caller typed ("+91 99...",
// "9199...") and are stored in more than one of those shapes historically,
// so a lookup has to try the variants. What it must NOT do is build the
// filter by string concatenation: PostgREST's `.or()` takes a filter
// expression, so an unescaped value there is parsed as syntax rather than
// data. `.in()` sends the values as values.
function normalisePhone(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

function phoneVariants(raw: unknown): string[] {
  const digits = normalisePhone(raw);
  if (!digits) return [];
  const variants = new Set([digits, `+${digits}`]);
  if (typeof raw === "string" && raw.trim()) variants.add(raw.trim());
  return [...variants];
}

async function hashOTP(otp: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// reset_verify hands out one of these after a real OTP check; reset_password
// requires it. This is what actually ties the two calls together — without
// it, reset_password had nothing stopping it being called on its own with an
// arbitrary user_id and no OTP at all.
async function makeResetToken(userId: string, secret: string): Promise<string> {
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes to complete step 3
  const mac = await hmacHex(secret, `reset:${userId}:${expiresAt}`);
  return `${expiresAt}.${mac}`;
}

async function verifyResetToken(userId: string, token: unknown, secret: string): Promise<boolean> {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const [expiresAtStr, mac] = token.split(".");
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || !mac) return false;
  if (Date.now() > expiresAt) return false;
  const expectedMac = await hmacHex(secret, `reset:${userId}:${expiresAt}`);
  return expectedMac === mac;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      phone,
      otp,
      email,
      password,
      full_name,
      phone_e164,
      profession,
      hospital,
      user_id,
      action,
      reset_token,
      role,
      linked_clinician_id
    } = body;

    // role/linked_clinician_id are logged because they are the one part of
    // this payload whose absence is invisible in the result: a dropped role
    // still upserts a perfectly valid profile, just a clinician one. Phone
    // numbers, emails and user ids are personal data and stay out of the log:
    // presence flags are enough to debug a request's shape.
    console.log("[verify_whatsapp_otp] Request:", JSON.stringify({
      action: action ?? null,
      phonePresent: !!phone,
      otpPresent: !!otp,
      emailPresent: !!email,
      passwordPresent: !!password,
      userIdPresent: !!user_id,
      role: role ?? null,
      linkedClinicianPresent: !!linked_clinician_id
    }));

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    // The reset token is an HMAC; its key should be a secret that exists for
    // this purpose alone, not the service-role key (which would make a leak
    // of either one a leak of both). Falls back to the old key until
    // OTP_RESET_TOKEN_SECRET is set -- tokens live 10 minutes, so switching
    // over invalidates at most the resets in flight at that moment.
    const resetTokenSecret = Deno.env.get("OTP_RESET_TOKEN_SECRET") || supabaseServiceRoleKey;

    // Fast helper 1: resolve the sign-in email for a registered phone number.
    //
    // Phone+password login needs an email because that is what
    // signInWithPassword takes, and the browser only has the phone number.
    // This used to accept a caller-supplied `user_id` and hand back that
    // account's email with no further condition, which made it an
    // id-to-email lookup for any account. It now keys off the phone number
    // instead: you have to already know a registered number to learn the
    // address behind it, and an ambiguous number resolves to nothing.
    //
    // Deliberately left client-side: the actual password check stays on
    // supabase.auth.signInWithPassword in the browser, so Supabase Auth's
    // per-IP sign-in rate limit still applies per end user. Proxying the
    // sign-in through this function would put every login behind one egress
    // IP and let that limit throttle everybody at once.
    if (action === "get_email") {
      const variants = phoneVariants(phone);
      if (variants.length === 0) {
        return new Response(
          JSON.stringify({ email: null }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: matches, error: matchErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .in("whatsapp_number", variants)
        .limit(2);

      // Exactly one account, or nothing: the same number stored in two
      // formats would otherwise make "which account" a guess.
      if (matchErr || !matches || matches.length !== 1) {
        return new Response(
          JSON.stringify({ email: null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(matches[0].id);
      return new Response(
        JSON.stringify({ email: userData?.user?.email || null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fast helper 2: reset_password for user_id (OTP already verified in previous reset_verify step)
    if (action === "reset_password") {
      console.log("[verify_whatsapp_otp] Action: reset_password");
      let targetUserId = user_id;

      if (!targetUserId && phone) {
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .in("whatsapp_number", phoneVariants(phone));
        if (profiles && profiles.length > 0) {
          targetUserId = profiles[0].id;
        }
      }

      if (!targetUserId || !password) {
        return new Response(
          JSON.stringify({ error: "User ID and new password are required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // This action has no OTP of its own — it only trusts that reset_verify
      // ran a real OTP check moments earlier. That trust must be provable,
      // not just asserted by the caller, or anyone with a user_id (or a
      // registered phone number) could reset any account's password with no
      // OTP at all. reset_token is the proof: a short-lived, server-signed
      // ticket minted by reset_verify for this exact user_id.
      const validToken = await verifyResetToken(targetUserId, reset_token, resetTokenSecret);
      if (!validToken) {
        return new Response(
          JSON.stringify({ error: "Your password reset session has expired. Please verify your OTP again." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: passData, error: passErr } = await supabaseAdmin.auth.admin.updateUserById(
        targetUserId,
        { password: password }
      );

      if (passErr) {
        console.error("[verify_whatsapp_otp] reset_password error:", JSON.stringify(passErr, Object.getOwnPropertyNames(passErr)));
        return new Response(
          JSON.stringify({ error: `Failed to reset password: ${passErr.message}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("[verify_whatsapp_otp] reset_password succeeded:", !!passData?.user?.id);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validation for OTP-dependent actions (login, signup, reset_verify)
    if (!phone || !otp) {
      return new Response(
        JSON.stringify({ error: "Phone number and OTP are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Step 1: Verify OTP from whatsapp_otps ---
    const otpHash = await hashOTP(otp);

    // Clean phone to digits only for lookup
    const cleanPhone = phone.replace(/\D/g, "");

    const { data: otpRecord, error: otpError } = await supabaseAdmin
      .from("whatsapp_otps")
      .select("*")
      .in("phone", phoneVariants(phone))
      .eq("verified", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpError || !otpRecord) {
      console.log("[verify_whatsapp_otp] No pending OTP record for this phone");
      return new Response(
        JSON.stringify({ error: "OTP expired or invalid. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: "OTP has expired. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (otpRecord.attempts >= otpRecord.max_attempts) {
      return new Response(
        JSON.stringify({ error: "Maximum OTP attempts exceeded. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // The attempt counter is the only brake on guessing a 6-digit code. If it
    // cannot be advanced, refuse rather than check the guess uncounted.
    const { error: attemptErr } = await supabaseAdmin
      .from("whatsapp_otps")
      .update({ attempts: otpRecord.attempts + 1 })
      .eq("id", otpRecord.id);
    if (attemptErr) {
      console.error("[verify_whatsapp_otp] could not record the attempt:", attemptErr.code);
      return new Response(
        JSON.stringify({ error: "Verification is temporarily unavailable. Please try again." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (otpHash !== otpRecord.otp_hash) {
      return new Response(
        JSON.stringify({ error: "Incorrect OTP. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Atomically claim the OTP: the WHERE verified = false makes this a
    // compare-and-swap, so if two requests raced to this point (double-click,
    // replay) only one can flip verified false→true and proceed below — the
    // other gets 0 rows back and is rejected, instead of both going on to run
    // Action B / reset_password a second time.
    const { data: claimedOtp, error: claimErr } = await supabaseAdmin
      .from("whatsapp_otps")
      .update({ verified: true })
      .eq("id", otpRecord.id)
      .eq("verified", false)
      .select("id")
      .maybeSingle();

    if (claimErr || !claimedOtp) {
      return new Response(
        JSON.stringify({ error: "This OTP has already been used. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[verify_whatsapp_otp] OTP verified successfully!");

    // --- Step 2: Handle Actions ---

    // Action: Reset Password - Verify OTP and retrieve user_id
    if (action === "reset_verify") {
      console.log("[verify_whatsapp_otp] Action: reset_verify");
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .in("whatsapp_number", phoneVariants(phone));

      if (profileErr || !profiles || profiles.length === 0) {
        return new Response(
          JSON.stringify({ error: "No registered account found with this phone number." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const resetToken = await makeResetToken(profiles[0].id, resetTokenSecret);

      return new Response(
        JSON.stringify({ success: true, user_id: profiles[0].id, reset_token: resetToken }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }



    // Action A: Login via OTP
    if (action === "login" || (!action && !user_id && !email && !password)) {
      console.log("[verify_whatsapp_otp] Handling OTP login");

      // Find profile by whatsapp_number
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .in("whatsapp_number", phoneVariants(phone));

      if (profileErr || !profiles || profiles.length === 0) {
        return new Response(
          JSON.stringify({ error: "No account found registered with this phone number." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const userId = profiles[0].id;
      const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);

      if (userErr || !userData.user || !userData.user.email) {
        return new Response(
          JSON.stringify({ error: "Associated user account not found." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const userEmail = userData.user.email;

      // Generate a magic link / OTP token for direct client authentication
      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email: userEmail,
      });

      if (linkErr || !linkData.properties?.email_otp) {
        console.error("[verify_whatsapp_otp] generateLink error:", linkErr);
        return new Response(
          JSON.stringify({ error: "Failed to generate login token." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          email: userEmail,
          email_otp: linkData.properties.email_otp,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action B: Signup / Existing User Update (Google OAuth completion, or an
    // authenticated user changing their own WhatsApp number from their profile)
    if (user_id) {
      console.log("[verify_whatsapp_otp] Updating an existing user");

      // --- Identity check: this branch writes to a specific profile, so the
      // caller must be authenticated as that exact user. Never trust the
      // body-supplied user_id on its own — resolve the real caller from their
      // JWT and require it to match. ---
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "Authentication required." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const supabaseAsCaller = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: callerData, error: callerErr } = await supabaseAsCaller.auth.getUser();
      if (callerErr || !callerData?.user) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired session. Please log in again." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (callerData.user.id !== user_id) {
        console.error("[verify_whatsapp_otp] user_id mismatch: JWT subject differs from requested user_id");
        return new Response(
          JSON.stringify({ error: "You can only update your own profile." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // --- Role and clinician link: validated here, never trusted as sent.
      // role must be one of the three account types. A link is accepted only
      // for a Site Data Coordinator, and only to a verified clinician's
      // account -- not to an arbitrary id, an MTB Expert, another coordinator
      // or a half-registered account. (Whether the clinician has agreed is a
      // separate question, answered by the in-app approval flow.) ---
      const ALLOWED_ROLES = ["clinician", "site_data_coordinator", "mtb_expert"];
      if (role !== undefined && role !== null && !ALLOWED_ROLES.includes(role)) {
        return new Response(
          JSON.stringify({ error: "Unknown account type." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      let validatedClinicianId: string | null = null;
      if (role === "site_data_coordinator") {
        if (typeof linked_clinician_id !== "string" || !linked_clinician_id) {
          return new Response(
            JSON.stringify({ error: "A Site Data Coordinator account needs a linked clinician." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const { data: clinician, error: clinicianErr } = await supabaseAdmin
          .from("profiles")
          .select("id, role, whatsapp_verified")
          .eq("id", linked_clinician_id)
          .maybeSingle();
        if (clinicianErr || !clinician || clinician.role !== "clinician" ||
            clinician.whatsapp_verified !== true || clinician.id === user_id) {
          return new Response(
            JSON.stringify({ error: "The linked clinician's account could not be confirmed." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        validatedClinicianId = clinician.id;
      }

      // --- Reject if this WhatsApp number is already registered to a
      // different account, before making any writes. ---
      const { data: existingOwners, error: dupErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .in("whatsapp_number", phoneVariants(phone))
        .neq("id", user_id);

      if (dupErr) {
        console.error("[verify_whatsapp_otp] duplicate-check error:", JSON.stringify(dupErr, Object.getOwnPropertyNames(dupErr)));
      } else if (existingOwners && existingOwners.length > 0) {
        return new Response(
          JSON.stringify({ error: "This WhatsApp number is already registered to another account." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Step B1: Update Password on auth.users (CRITICAL)
      if (password) {
        console.log("[verify_whatsapp_otp] Step B1: Updating password");
        const { data: passData, error: passErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          password: password,
        });

        if (passErr) {
          console.error("[verify_whatsapp_otp] CRITICAL ERROR in password update:", JSON.stringify(passErr, Object.getOwnPropertyNames(passErr)));
          // Supabase Auth's own message (e.g. a password-policy rule) is
          // written for end users; anything else stays in the server log.
          return new Response(
            JSON.stringify({ error: `Failed to set your password: ${passErr.message || "please try again."}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        console.log("[verify_whatsapp_otp] Step B1 SUCCESS:", !!passData?.user?.id);
      }

      // Step B2: Optional auth.users.phone update (Non-blocking if SMS provider is unconfigured)
      const targetPhoneE164 = phone_e164 || `+${cleanPhone}`;
      try {
        console.log("[verify_whatsapp_otp] Step B2: Attempting optional auth.users.phone update");
        const { error: phoneErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          phone: targetPhoneE164,
          phone_confirm: true,
        });

        if (phoneErr) {
          console.log("[verify_whatsapp_otp] Step B2 NOTICE: Optional auth.users.phone update returned error (non-critical, skipped):", JSON.stringify(phoneErr, Object.getOwnPropertyNames(phoneErr)));
        } else {
          console.log("[verify_whatsapp_otp] Step B2 SUCCESS: Optional auth.users.phone update succeeded");
        }
      } catch (phoneEx) {
        console.log("[verify_whatsapp_otp] Step B2 NOTICE: Optional auth.users.phone update threw exception (non-critical, skipped):", phoneEx);
      }

      // Step B3: Upsert profile in public.profiles (Source of truth for WhatsApp number)
      const profileData: Record<string, any> = {
        id: user_id,
        whatsapp_number: cleanPhone,
        whatsapp_verified: true,
        whatsapp_opt_in: true,
      };

      if (full_name) profileData.full_name = full_name;
      if (profession) profileData.profession = profession;
      if (hospital) profileData.hospital = hospital;
      // Only ever written here at signup completion, while whatsapp_verified
      // is still false on the existing row -- profiles_role_immutable locks
      // both columns the instant this same upsert flips whatsapp_verified
      // to true, so this is the one and only place role/linked_clinician_id
      // are ever set intentionally.
      if (role) profileData.role = role;
      // Only the link validated above; a link sent with any other role is
      // ignored rather than written.
      if (validatedClinicianId) profileData.linked_clinician_id = validatedClinicianId;

      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .upsert(profileData, { onConflict: "id" });

      if (profileError) {
        // This upsert is the one and only place role/linked_clinician_id are
        // ever written -- silently returning success here would leave the
        // caller believing their role choice was saved when it wasn't. The
        // database's own message (constraint and trigger names) stays in the
        // server log.
        console.error("[verify_whatsapp_otp] Step B3 CRITICAL ERROR: Profile upsert failed:", JSON.stringify(profileError, Object.getOwnPropertyNames(profileError)));
        return new Response(
          JSON.stringify({ error: "We couldn't save your profile. Please try again." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("[verify_whatsapp_otp] Step B3 SUCCESS: Profile upserted successfully");

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action C: Legacy New User creation (if email and password provided without user_id)
    //
    // Switched off. It created an account for any email address, marked as
    // confirmed, for anyone able to verify an OTP on their own phone -- so a
    // caller could pre-register someone else's address before they ever
    // signed up. No page calls it (its only client,
    // verifyWhatsAppOTPAndCreateUser, has no callers); signup goes through
    // Google OAuth and Action B. Left in place rather than deleted;
    // ALLOW_LEGACY_EMAIL_SIGNUP=true re-enables it.
    if (email && password && Deno.env.get("ALLOW_LEGACY_EMAIL_SIGNUP") !== "true") {
      return new Response(
        JSON.stringify({ error: "This sign-up method is no longer available." }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (email && password) {
      console.log("[verify_whatsapp_otp] Creating new user (legacy flow)");

      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        phone: phone_e164 || `+${cleanPhone}`,
        email_confirm: true,
        phone_confirm: true,
        user_metadata: { name: full_name },
      });

      if (createError) {
        return new Response(
          JSON.stringify({ error: createError.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      await supabaseAdmin.from("profiles").upsert({
        id: newUser.user!.id,
        full_name,
        profession: profession || null,
        hospital: hospital || null,
        whatsapp_number: cleanPhone,
        whatsapp_verified: true,
        whatsapp_opt_in: true,
      }, { onConflict: "id" });

      return new Response(
        JSON.stringify({ success: true, user_id: newUser.user!.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[verify_whatsapp_otp] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
