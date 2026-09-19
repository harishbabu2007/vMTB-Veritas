import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================
   INLINE CORS (NO _shared)
========================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/* =========================
   SUPABASE CLIENT (ADMIN)
========================= */
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/* =========================
   HELPERS
========================= */
function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================
   EDGE FUNCTION
========================= */
serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone } = await req.json();

    if (!phone) {
      return new Response(
        JSON.stringify({ error: "phone is required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const otp = generateOtp();
    const otpHash = await sha256(otp);

    const expiresAt = new Date(
      Date.now() +
        Number(Deno.env.get("OTP_EXPIRY_MINUTES") ?? 5) * 60 * 1000
    );

    // Store OTP
    await supabase.from("whatsapp_otps").insert({
      phone,
      otp_hash: otpHash,
      expires_at: expiresAt.toISOString(),
    });

    // ✅ FIX: For COPY_CODE button templates, we need to send button parameters
    // The template structure expects the OTP as body param AND as button param
    const body = new URLSearchParams({
      channel: "whatsapp",
      source: Deno.env.get("GUPSHUP_SOURCE_NUMBER")!,
      destination: phone,
      "src.name": Deno.env.get("GUPSHUP_APP_NAME")!,
      template: JSON.stringify({
        id: "b2db4719-70e5-4c85-a33c-a2563f504e18", // Your temp_otp template ID
        params: [
          String(otp), // This is for {{1}} in the message body
          String(otp)  // This is for the COPY_CODE button coupon_code parameter
        ],
      }),
    });

    const resp = await fetch(
      "https://api.gupshup.io/wa/api/v1/template/msg",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          apikey: Deno.env.get("GUPSHUP_API_KEY")!,
        },
        body,
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gupshup API error:", text);
      return new Response(
        JSON.stringify({ error: "Failed to send OTP", details: text }),
        { status: 500, headers: corsHeaders }
      );
    }

    const result = await resp.json();
    console.log("Gupshup response:", result);

    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error in send_whatsapp_otp:", err);
    return new Response(
      JSON.stringify({ error: "internal server error", details: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
