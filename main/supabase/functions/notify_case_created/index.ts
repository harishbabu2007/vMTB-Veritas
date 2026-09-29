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
    const mtbCaseRecord = payload.record;

    console.log("Received mtb_cases record:", mtbCaseRecord);

    // ✅ The webhook fires on mtb_cases table, so we have mtb_id and case_id
    if (!mtbCaseRecord?.mtb_id || !mtbCaseRecord?.case_id) {
      console.error("Invalid payload - missing mtb_id or case_id");
      return new Response("Invalid payload", { status: 400 });
    }

    // ✅ FIX 1: Fetch the actual case details from the cases table using case_id
    const { data: caseData, error: caseError } = await supabase
      .from("cases")
      .select("id, case_name, owner_id")
      .eq("id", mtbCaseRecord.case_id)
      .single();

    if (caseError || !caseData) {
      console.error("Case not found:", caseError);
      return new Response("Case not found", { status: 404 });
    }

    console.log("Found case:", caseData);

    // ✅ FIX 2: Fetch MTB name from mtbs table using mtb_id
    const { data: mtbData, error: mtbError } = await supabase
      .from("mtbs")
      .select("name")
      .eq("id", mtbCaseRecord.mtb_id)
      .single();

    if (mtbError || !mtbData) {
      console.error("Failed to fetch MTB:", mtbError);
      return new Response("MTB not found", { status: 404 });
    }

    const mtbName = mtbData.name;
    const caseName = caseData.case_name;

    console.log("Case name:", caseName);
    console.log("MTB name:", mtbName);

    // Get MTB members (exclude the case owner to avoid notifying them)
    const { data: members } = await supabase
      .from("mtb_members")
      .select("user_id")
      .eq("mtb_id", mtbCaseRecord.mtb_id)
      .neq("user_id", caseData.owner_id); // Don't notify the person who added the case

    if (!members || members.length === 0) {
      console.log("No other members found for MTB");
      return new Response("No members to notify", { status: 200 });
    }

    // Fetch profiles with WhatsApp opt-in
    const userIds = members.map((m) => m.user_id);

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, whatsapp_number, whatsapp_opt_in")
      .in("id", userIds)
      .eq("whatsapp_opt_in", true);

    if (!profiles || profiles.length === 0) {
      console.log("No opted-in members found");
      return new Response("No opted-in members", { status: 200 });
    }

    console.log(`Sending notifications to ${profiles.length} members`);

    // ✅ FIX 3: URL should be just the case ID, not the full URL
    // The template already has https://www.vmtb.in/case/{{1}} configured
    // So we only need to pass the case ID
    const caseId = caseData.id;

    // Track successful sends to avoid duplicates
    const sentNumbers = new Set();

    for (const profile of profiles) {
      // Skip if already sent to this number (prevents duplicates)
      if (sentNumbers.has(profile.whatsapp_number)) {
        console.log(`Already sent to ${profile.whatsapp_number}, skipping`);
        continue;
      }

      try {
        const result = await sendWhatsApp(
          profile.whatsapp_number,
          "e113b243-2370-4704-8674-fd952aeb844b", // add_case_message template ID
          [
            caseName,    // {{1}} - case name (NOT case ID!)
            mtbName,     // {{2}} - MTB name
            caseId       // {{3}} - just the UUID for the URL button
          ]
        );
        console.log(`Sent to ${profile.whatsapp_number}:`, result);
        sentNumbers.add(profile.whatsapp_number);
      } catch (error) {
        console.error(`Failed to send to ${profile.whatsapp_number}:`, error);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      notified: sentNumbers.size 
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Error in notify_case_created:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});