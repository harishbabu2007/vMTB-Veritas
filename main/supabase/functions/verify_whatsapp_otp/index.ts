// supabase/functions/verify_whatsapp_otp/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hashOTP(otp: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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
      action
    } = body;

    console.log("[verify_whatsapp_otp] Request:", JSON.stringify({
      phone,
      otp: otp ? "***" : undefined,
      email,
      passwordPresent: !!password,
      user_id,
      action
    }));

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Fast helper 1: get_email for user_id (Phone+Password login lookup)
    if (action === "get_email" && user_id) {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(user_id);
      return new Response(
        JSON.stringify({ email: userData?.user?.email || null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fast helper 2: reset_password for user_id (OTP already verified in previous reset_verify step)
    if (action === "reset_password") {
      console.log("[verify_whatsapp_otp] Action: reset_password for user_id:", user_id);
      let targetUserId = user_id;

      if (!targetUserId && phone) {
        const cleanP = phone.replace(/\D/g, "");
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .or(`whatsapp_number.eq.${cleanP},whatsapp_number.eq.${phone}`);
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

      console.log("[verify_whatsapp_otp] reset_password succeeded for user_id:", passData?.user?.id);
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
      .or(`phone.eq.${phone},phone.eq.${cleanPhone}`)
      .eq("verified", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpError || !otpRecord) {
      console.log("[verify_whatsapp_otp] No OTP record found for phone:", phone);
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

    await supabaseAdmin
      .from("whatsapp_otps")
      .update({ attempts: otpRecord.attempts + 1 })
      .eq("id", otpRecord.id);

    if (otpHash !== otpRecord.otp_hash) {
      return new Response(
        JSON.stringify({ error: "Incorrect OTP. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark OTP as verified
    await supabaseAdmin
      .from("whatsapp_otps")
      .update({ verified: true })
      .eq("id", otpRecord.id);

    console.log("[verify_whatsapp_otp] OTP verified successfully!");

    // --- Step 2: Handle Actions ---

    // Action: Reset Password - Verify OTP and retrieve user_id
    if (action === "reset_verify") {
      console.log("[verify_whatsapp_otp] Action: reset_verify for phone:", cleanPhone);
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .or(`whatsapp_number.eq.${cleanPhone},whatsapp_number.eq.${phone}`);

      if (profileErr || !profiles || profiles.length === 0) {
        return new Response(
          JSON.stringify({ error: "No registered account found with this phone number." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, user_id: profiles[0].id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }



    // Action A: Login via OTP
    if (action === "login" || (!action && !user_id && !email && !password)) {
      console.log("[verify_whatsapp_otp] Handling OTP Login for phone:", cleanPhone);

      // Find profile by whatsapp_number
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .or(`whatsapp_number.eq.${cleanPhone},whatsapp_number.eq.${phone}`);

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
      console.log("[verify_whatsapp_otp] Updating existing user ID:", user_id);

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

      // --- Reject if this WhatsApp number is already registered to a
      // different account, before making any writes. ---
      const { data: existingOwners, error: dupErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .or(`whatsapp_number.eq.${cleanPhone},whatsapp_number.eq.${phone}`)
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
        console.log("[verify_whatsapp_otp] Step B1: Updating password for user_id:", user_id);
        const { data: passData, error: passErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          password: password,
        });

        if (passErr) {
          console.error("[verify_whatsapp_otp] CRITICAL ERROR in password update:", JSON.stringify(passErr, Object.getOwnPropertyNames(passErr)));
          return new Response(
            JSON.stringify({ error: `Failed to attach password to user: ${passErr.message || JSON.stringify(passErr)}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        console.log("[verify_whatsapp_otp] Step B1 SUCCESS: Password updated for user_id:", passData?.user?.id);
      }

      // Step B2: Optional auth.users.phone update (Non-blocking if SMS provider is unconfigured)
      const targetPhoneE164 = phone_e164 || `+${cleanPhone}`;
      try {
        console.log("[verify_whatsapp_otp] Step B2: Attempting optional auth.users.phone update:", targetPhoneE164);
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

      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .upsert(profileData, { onConflict: "id" });

      if (profileError) {
        console.error("[verify_whatsapp_otp] Step B3 WARNING: Profile upsert error:", JSON.stringify(profileError, Object.getOwnPropertyNames(profileError)));
      } else {
        console.log("[verify_whatsapp_otp] Step B3 SUCCESS: Profile upserted successfully");
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action C: Legacy New User creation (if email and password provided without user_id)
    if (email && password) {
      console.log("[verify_whatsapp_otp] Creating new user with email:", email);

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
