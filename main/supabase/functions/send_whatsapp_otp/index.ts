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
// Math.random() is not a cryptographic source, and this value is the only
// thing standing between a phone number and a session. Rejection sampling
// keeps the six digits uniform: 4294967296 is not a multiple of 900000, so
// taking a modulus of every draw would bias the low end.
function generateOtp(): string {
  const limit = 900000;
  const ceiling = Math.floor(0xffffffff / limit) * limit;
  const buf = new Uint32Array(1);
  let draw: number;
  do {
    crypto.getRandomValues(buf);
    draw = buf[0];
  } while (draw >= ceiling);
  return (100000 + (draw % limit)).toString();
}

// The OTP table is matched on this exact string, so send and verify have to
// agree on the format or a valid code looks unknown. Digits only, no "+".
function normalisePhone(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Every limit below protects a billable send, so a limit we cannot evaluate
// is treated as exceeded. Failing open here is what lets a database hiccup
// turn into an unthrottled message flood.
const limitUnavailable = (): Response =>
  json({ error: "OTP sending is temporarily unavailable. Please try again later." }, 503);

/* =========================
   EDGE FUNCTION
========================= */
serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    // Normalised before anything else, so the rate limit below cannot be
    // sidestepped by alternating "+9199..." and "9199..." for the same phone.
    const phone = normalisePhone(body?.phone);

    if (!phone) {
      return json({ error: "phone is required" }, 400);
    }

    // Rate limit: a short cooldown between sends, plus a cap on how many can
    // be requested for one phone number in a longer window. Previously
    // nothing throttled this at all.
    const now = Date.now();
    const cooldownSince = new Date(now - 60 * 1000).toISOString();
    const windowSince = new Date(now - 15 * 60 * 1000).toISOString();

    const { data: recentOtps, error: recentErr } = await supabase
      .from("whatsapp_otps")
      .select("created_at")
      .eq("phone", phone)
      .gte("created_at", windowSince)
      .order("created_at", { ascending: false });

    if (recentErr || !recentOtps) {
      console.error("[send_whatsapp_otp] per-phone limit check failed:", recentErr?.code);
      return limitUnavailable();
    }
    if (recentOtps.length > 0 && recentOtps[0].created_at > cooldownSince) {
      return json({ error: "Please wait a minute before requesting another OTP." }, 429);
    }
    if (recentOtps.length >= 5) {
      return json({ error: "Too many OTP requests. Please try again in a few minutes." }, 429);
    }

    // Login asks for a code only for an account that exists. This used to be
    // a browser read of `profiles` that anyone could make for free. Asking
    // here keeps the question inside this function, where the planned
    // per-IP limit will cover it (a refused number writes no OTP row, so the
    // per-phone limit above does not count it), and no code is sent -- or
    // paid for -- for a number with no account.
    if (body?.purpose === "login") {
      const { data: owners, error: ownerErr } = await supabase
        .from("profiles")
        .select("id")
        .in("whatsapp_number", [phone, `+${phone}`])
        .limit(1);
      if (ownerErr) {
        console.error("[send_whatsapp_otp] account lookup failed:", ownerErr.code);
        return limitUnavailable();
      }
      if (!owners || owners.length === 0) {
        return json({ error: "No account was found with this phone number.", code: "not_registered" }, 404);
      }
    }

    // The per-phone limits above bound one number; they do nothing about many
    // numbers. Every send is a billable WhatsApp message, so cap the total
    // too -- otherwise a caller cycling through numbers can run up the
    // Gupshup bill unbounded. Deliberately a blunt global ceiling: this
    // function has no authenticated caller to attribute spend to.
    const hourSince = new Date(now - 60 * 60 * 1000).toISOString();
    const globalCap = Number(Deno.env.get("OTP_GLOBAL_HOURLY_CAP") ?? 200);
    const { count: hourlyCount, error: countErr } = await supabase
      .from("whatsapp_otps")
      .select("id", { count: "exact", head: true })
      .gte("created_at", hourSince);

    if (countErr || typeof hourlyCount !== "number") {
      console.error("[send_whatsapp_otp] global limit check failed:", countErr?.code);
      return limitUnavailable();
    }
    if (hourlyCount >= globalCap) {
      console.error(
        `[send_whatsapp_otp] global hourly cap reached: ${hourlyCount} >= ${globalCap}`,
      );
      return json({ error: "OTP sending is temporarily unavailable. Please try again later." }, 429);
    }

    const otp = generateOtp();
    const otpHash = await sha256(otp);

    const expiresAt = new Date(
      Date.now() +
        Number(Deno.env.get("OTP_EXPIRY_MINUTES") ?? 5) * 60 * 1000
    );

    // Store OTP. If the row cannot be written, the code would be unverifiable
    // and invisible to the limits above, so nothing is sent.
    const { error: insertErr } = await supabase.from("whatsapp_otps").insert({
      phone,
      otp_hash: otpHash,
      expires_at: expiresAt.toISOString(),
    });
    if (insertErr) {
      console.error("[send_whatsapp_otp] could not store OTP:", insertErr.code);
      return limitUnavailable();
    }

    // ✅ FIX: For COPY_CODE button templates, we need to send button parameters
    // The template structure expects the OTP as body param AND as button param
    const gupshupBody = new URLSearchParams({
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
        body: gupshupBody,
      }
    );

    // Provider responses stay in the server log only: they echo the
    // destination number and carry provider internals the browser has no use
    // for.
    if (!resp.ok) {
      console.error("[send_whatsapp_otp] Gupshup API error: HTTP", resp.status, await resp.text());
      return json({ error: "Failed to send OTP. Please try again." }, 502);
    }

    const result = await resp.json();
    console.log("[send_whatsapp_otp] Gupshup accepted the message:", result?.status ?? "unknown status");

    return json({ success: true });
  } catch (err) {
    console.error("[send_whatsapp_otp] unexpected error:", err);
    return json({ error: "Failed to send OTP. Please try again." }, 500);
  }
});
