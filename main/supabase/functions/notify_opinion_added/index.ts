import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function sendWhatsApp(
  phone: string,
  templateId: string,
  params: string[]
) {
  const body = new URLSearchParams({
    channel: "whatsapp",
    source: Deno.env.get("GUPSHUP_SOURCE_NUMBER")!,
    destination: phone,
    "src.name": Deno.env.get("GUPSHUP_APP_NAME")!,
    template: JSON.stringify({
      id: templateId,
      params,
    }),
  });

  const resp = await fetch("https://api.gupshup.io/wa/api/v1/template/msg", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      apikey: Deno.env.get("GUPSHUP_API_KEY")!,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Gupshup error:", text);
    throw new Error(`Gupshup API failed: ${text}`);
  }

  return await resp.json();
}

serve(async (req) => {
  try {
    const payload = await req.json();
    const opinion = payload.record;

    console.log("Received case_opinions record:", opinion);

    if (!opinion?.case_id) {
      console.error("Invalid payload - missing case_id");
      return new Response("Invalid payload", { status: 400 });
    }

    const { data: caseData, error: caseError } = await supabase
      .from("cases")
      .select("id, case_name, owner_id")
      .eq("id", opinion.case_id)
      .single();

    if (caseError || !caseData) {
      console.error("Case not found:", caseError);
      return new Response("Case not found", { status: 404 });
    }

    console.log("Found case:", caseData);

    // ✅ NEW CHECK: If the opinion was added by the case owner himself, skip notification
    if (opinion.user_id && caseData.owner_id === opinion.user_id) {
      console.log("Opinion added by case owner themselves — skipping notification");
      return new Response("Opinion by owner, notification skipped", { status: 200 });
    }

    const { data: mtbCaseData, error: mtbCaseError } = await supabase
      .from("mtb_cases")
      .select("mtb_id")
      .eq("case_id", opinion.case_id)
      .limit(1)
      .single();

    if (mtbCaseError || !mtbCaseData) {
      console.error("MTB case mapping not found:", mtbCaseError);
      console.log("Case not associated with MTB, will send notification anyway");
    }

    let mtbName = "your MTB";

    if (mtbCaseData?.mtb_id) {
      const { data: mtbData, error: mtbError } = await supabase
        .from("mtbs")
        .select("name")
        .eq("id", mtbCaseData.mtb_id)
        .single();

      if (!mtbError && mtbData) {
        mtbName = mtbData.name;
      }
    }

    console.log("Case name:", caseData.case_name);
    console.log("MTB name:", mtbName);
    console.log("Case owner:", caseData.owner_id);

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, whatsapp_number, whatsapp_opt_in")
      .eq("id", caseData.owner_id)
      .single();

    if (profileError || !profile) {
      console.error("Owner profile not found:", profileError);
      return new Response("Owner not found", { status: 404 });
    }

    console.log("Found owner profile:", profile.id);

    if (!profile.whatsapp_opt_in) {
      console.log("Owner not opted in for WhatsApp");
      return new Response("Owner not opted in", { status: 200 });
    }

    if (!profile.whatsapp_number) {
      console.log("Owner has no WhatsApp number");
      return new Response("Owner has no WhatsApp number", { status: 200 });
    }

    console.log("Sending notification to owner:", profile.whatsapp_number);

    const result = await sendWhatsApp(
      profile.whatsapp_number,
      "3d2083b3-6af6-4e0e-b2c6-0856e74bdc63",
      [
        caseData.case_name,
        mtbName,
        caseData.id
      ]
    );

    console.log("Notification sent successfully:", result);

    return new Response(JSON.stringify({ 
      success: true,
      messageId: result.messageId 
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Error in notify_opinion_added:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});