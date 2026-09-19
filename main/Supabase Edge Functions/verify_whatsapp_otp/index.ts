// import { serve } from "https://deno.land/std/http/server.ts";
// import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// /* =========================
//    INLINE CORS
// ========================= */
// const corsHeaders = {
//   "Access-Control-Allow-Origin": "*",
//   "Access-Control-Allow-Headers":
//     "authorization, x-client-info, apikey, content-type",
// };

// /* =========================
//    SUPABASE CLIENT (ADMIN)
// ========================= */
// const supabase = createClient(
//   Deno.env.get("SUPABASE_URL")!,
//   Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// );

// /* =========================
//    HELPERS
// ========================= */
// async function sha256(input: string): Promise<string> {
//   const data = new TextEncoder().encode(input);
//   const hash = await crypto.subtle.digest("SHA-256", data);
//   return Array.from(new Uint8Array(hash))
//     .map((b) => b.toString(16).padStart(2, "0"))
//     .join("");
// }

// /* =========================
//    EDGE FUNCTION
// ========================= */
// serve(async (req) => {
//   console.log("========== verify_whatsapp_otp START ==========");

//   // ✅ CORS preflight
//   if (req.method === "OPTIONS") {
//     console.log("OPTIONS request received");
//     return new Response("ok", { headers: corsHeaders });
//   }

//   try {
//     const body = await req.json();

//     console.log("Received Request Body:", body);

//     const { phone, otp, email, password, full_name } = body;

//     console.log("Parsed Fields:", {
//       phone,
//       otp,
//       email,
//       passwordPresent: !!password,
//       full_name,
//     });

//     if (!phone || !otp || !email || !password) {
//       console.error("Validation Failed: Missing required fields", {
//         phone,
//         otp,
//         email,
//         passwordPresent: !!password,
//         full_name,
//       });

//       return new Response(
//         JSON.stringify({ error: "missing required fields" }),
//         { status: 400, headers: corsHeaders }
//       );
//     }

//     const otpHash = await sha256(otp);

//     console.log("Generated OTP Hash:", otpHash);

//     // Fetch latest valid OTP
//     const { data: records, error: fetchError } = await supabase
//       .from("whatsapp_otps")
//       .select("*")
//       .eq("phone", phone)
//       .eq("verified", false)
//       .gt("expires_at", new Date().toISOString())
//       .order("created_at", { ascending: false })
//       .limit(1);

//     console.log("Database Query Error:", fetchError);
//     console.log("OTP Records Found:", records);

//     if (!records || records.length === 0) {
//       console.error("No valid OTP record found.", {
//         phone,
//         currentTime: new Date().toISOString(),
//       });

//       return new Response(
//         JSON.stringify({ error: "OTP expired or invalid" }),
//         { status: 400, headers: corsHeaders }
//       );
//     }

//     const record = records[0];

//     console.log("Latest OTP Record:", {
//       id: record.id,
//       phone: record.phone,
//       verified: record.verified,
//       attempts: record.attempts,
//       max_attempts: record.max_attempts,
//       expires_at: record.expires_at,
//       stored_hash: record.otp_hash,
//     });

//     if (record.attempts >= record.max_attempts) {
//       console.error("Maximum OTP attempts exceeded.", {
//         attempts: record.attempts,
//         max_attempts: record.max_attempts,
//       });

//       return new Response(
//         JSON.stringify({ error: "too many attempts" }),
//         { status: 403, headers: corsHeaders }
//       );
//     }

//     console.log("Comparing OTP Hashes...");
//     console.log("Stored Hash :", record.otp_hash);
//     console.log("Entered Hash:", otpHash);

//     if (record.otp_hash !== otpHash) {
//       console.error("OTP Hash Mismatch");

//       const { error: updateError } = await supabase
//         .from("whatsapp_otps")
//         .update({ attempts: record.attempts + 1 })
//         .eq("id", record.id);

//       console.log("Attempt Increment Error:", updateError);

//       return new Response(
//         JSON.stringify({ error: "invalid OTP" }),
//         { status: 400, headers: corsHeaders }
//       );
//     }

//     console.log("OTP Verified Successfully");

//     // Mark OTP as used
//     const { error: verifyUpdateError } = await supabase
//       .from("whatsapp_otps")
//       .update({ verified: true })
//       .eq("id", record.id);

//     console.log("Mark Verified Update Error:", verifyUpdateError);

//     console.log("Fetching authenticated user from JWT...");

//     const authHeader = req.headers.get("Authorization");

//     if (!authHeader) {
//       console.error("Authorization header missing");

//       return new Response(
//         JSON.stringify({ error: "Authorization header missing" }),
//         { status: 401, headers: corsHeaders }
//       );
//     }

//     const jwt = authHeader.replace("Bearer ", "");

//     const {
//       data: { user },
//       error: authError,
//     } = await supabase.auth.getUser(jwt);

//     console.log("Authenticated User:", user);
//     console.log("Auth Error:", authError);

//     if (authError || !user) {
//       console.error("Failed to fetch authenticated user");

//       return new Response(
//         JSON.stringify({ error: "Unable to fetch authenticated user" }),
//         { status: 401, headers: corsHeaders }
//       );
//     }

//     console.log("Checking if profile already exists...");

//     const { data: existingProfile, error: profileFetchError } = await supabase
//       .from("profiles")
//       .select("id")
//       .eq("id", user.id)
//       .maybeSingle();

//     console.log("Existing Profile:", existingProfile);
//     console.log("Profile Fetch Error:", profileFetchError);

//     if (existingProfile) {
//       console.log("Updating existing profile...");

//       const { error: updateError } = await supabase
//         .from("profiles")
//         .update({
//           full_name,
//           whatsapp_number: phone,
//           whatsapp_verified: true,
//           whatsapp_opt_in: true,
//           updated_at: new Date().toISOString(),
//         })
//         .eq("id", user.id);

//       console.log("Profile Update Error:", updateError);

//       if (updateError) {
//         return new Response(
//           JSON.stringify({ error: updateError.message }),
//           { status: 400, headers: corsHeaders }
//         );
//       }
//     } else {
//       console.log("Creating new profile...");

//       const { error: insertError } = await supabase
//         .from("profiles")
//         .insert({
//           id: user.id,
//           full_name,
//           whatsapp_number: phone,
//           whatsapp_verified: true,
//           whatsapp_opt_in: true,
//         });

//       console.log("Profile Insert Error:", insertError);

//       if (insertError) {
//         return new Response(
//           JSON.stringify({ error: insertError.message }),
//           { status: 400, headers: corsHeaders }
//         );
//       }
//     }

//     return new Response(
//       JSON.stringify({ success: true }),
//       {
//         headers: {
//           ...corsHeaders,
//           "Content-Type": "application/json",
//         },
//       }
//     );
//   } catch (err) {
//     console.error("========== verify_whatsapp_otp EXCEPTION ==========");
//     console.error(err);

//     return new Response(
//       JSON.stringify({ error: "internal server error" }),
//       { status: 500, headers: corsHeaders }
//     );
//   }
// });




// supabase/functions/verify_whatsapp_otp/index.ts
//
// This Edge Function handles WhatsApp OTP verification for TWO flows:
//
// Flow 1 (New User - legacy):
//   Body: { phone, otp, email, password, full_name, profession?, hospital? }
//   → Verifies OTP → Creates auth user → Creates profile → Returns success
//
// Flow 2 (Existing User - Google OAuth signup):
//   Body: { phone, otp, user_id? }
//   → Verifies OTP → Marks phone as verified → Returns success
//   → The frontend handles profile creation and password update separately
//
// The function determines which flow to use based on whether email/password
// are present in the request body.

// supabase/functions/verify_whatsapp_otp/index.ts

// supabase/functions/verify_whatsapp_otp/index.ts

// supabase/functions/verify_whatsapp_otp/index.ts

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

    // Action B: Signup / Existing User Update (Google OAuth completion)
    if (user_id) {
      console.log("[verify_whatsapp_otp] Updating existing user ID:", user_id);

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
