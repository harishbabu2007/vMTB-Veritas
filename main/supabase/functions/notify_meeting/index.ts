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
    const meetingSession = payload.record;

    console.log("Received meeting_sessions record:", meetingSession);

    if (!meetingSession?.mtb_id || !meetingSession?.room_name) {
      console.error("Invalid payload - missing mtb_id or room_name");
      return new Response("Invalid payload", { status: 400 });
    }

    const mtbId = meetingSession.mtb_id;
    const roomName = meetingSession.room_name;

    console.log("MTB ID:", mtbId);
    console.log("Room name:", roomName);

    // Fetch MTB name
    const { data: mtbData, error: mtbError } = await supabase
      .from("mtbs")
      .select("name, notification_enabled")
      .eq("id", mtbId)
      .single();

    if (mtbError || !mtbData) {
      console.error("MTB not found:", mtbError);
      return new Response("MTB not found", { status: 404 });
    }

    const mtbName = mtbData.name;
    const notificationEnabled = mtbData.notification_enabled;

    console.log("Notification enabled:", notificationEnabled);

    if (!notificationEnabled) {
      console.log("Notifications are disabled for this MTB");
      return new Response("Notifications disabled for this MTB", { status: 200 });
    }

    console.log("MTB name:", mtbName);

    const meetingUrlParam = `${roomName}&mtb_id=${mtbId}`;
    console.log("Meeting URL parameter:", meetingUrlParam);

    // Get all members
    const { data: members, error: membersError } = await supabase
      .from("mtb_members")
      .select("user_id")
      .eq("mtb_id", mtbId);

    if (membersError) {
      console.error("Error fetching MTB members:", membersError);
      return new Response("Error fetching members", { status: 500 });
    }

    if (!members || members.length === 0) {
      console.log("No members found for this MTB");
      return new Response("No members to notify", { status: 200 });
    }

    console.log(`Found ${members.length} members in MTB`);
    const userIds = members.map((m) => m.user_id);
    console.log("User IDs:", userIds);

    // ✅ DEBUGGING: Fetch ALL profiles (not filtering by opt_in yet)
    const { data: allProfiles, error: allProfilesError } = await supabase
      .from("profiles")
      .select("id, whatsapp_number, whatsapp_opt_in, whatsapp_verified, full_name")
      .in("id", userIds);

    if (allProfilesError) {
      console.error("Error fetching profiles:", allProfilesError);
      return new Response("Error fetching profiles", { status: 500 });
    }

    console.log("\n=== DEBUGGING ALL MEMBER PROFILES ===");
    for (const profile of allProfiles || []) {
      console.log(`\nUser ${profile.id}:`);
      console.log(`  Name: ${profile.full_name || "N/A"}`);
      console.log(`  WhatsApp Number: ${profile.whatsapp_number || "MISSING"}`);
      console.log(`  WhatsApp Opt-in: ${profile.whatsapp_opt_in}`);
      console.log(`  WhatsApp Verified: ${profile.whatsapp_verified}`);
      
      if (!profile.whatsapp_number) {
        console.log(`  ❌ SKIP REASON: No WhatsApp number`);
      } else if (profile.whatsapp_opt_in !== true) {
        console.log(`  ❌ SKIP REASON: Not opted in (value: ${profile.whatsapp_opt_in})`);
      } else {
        console.log(`  ✅ WILL SEND notification`);
      }
    }
    console.log("=== END DEBUG ===\n");

    // ✅ UPDATED: More lenient opt-in check
    // Consider users opted-in if they have a WhatsApp number and are verified
    const eligibleProfiles = (allProfiles || []).filter(
      (p) => p.whatsapp_number && 
             (p.whatsapp_opt_in === true || p.whatsapp_verified === true)
    );

    console.log(`${eligibleProfiles.length} members are eligible to receive notifications`);

    if (eligibleProfiles.length === 0) {
      console.log("No eligible members found");
      return new Response("No eligible members", { status: 200 });
    }

    // Send notifications
    const sentNumbers = new Set();
    let successCount = 0;
    let failCount = 0;

    for (const profile of eligibleProfiles) {
      if (sentNumbers.has(profile.whatsapp_number)) {
        console.log(`Already sent to ${profile.whatsapp_number}, skipping`);
        continue;
      }

      try {
        const result = await sendWhatsApp(
          profile.whatsapp_number,
          "3ff8f599-2d18-4f2d-a337-3db91fc61221",
          [mtbName, meetingUrlParam]
        );

        console.log(`✅ Sent to ${profile.whatsapp_number}:`, result);
        sentNumbers.add(profile.whatsapp_number);
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to send to ${profile.whatsapp_number}:`, error);
        failCount++;
      }
    }

    console.log(`Meeting notifications complete: ${successCount} sent, ${failCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        mtb_name: mtbName,
        room_name: roomName,
        meeting_url_param: meetingUrlParam,
        total_members: members.length,
        eligible_members: eligibleProfiles.length,
        notifications_sent: successCount,
        failed: failCount,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );

  } catch (error) {
    console.error("Error in notify_meeting_initiated:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});