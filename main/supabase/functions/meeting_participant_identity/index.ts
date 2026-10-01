// ============================================================================
// meeting_participant_identity
// ============================================================================
// Binds a Jitsi meeting participant to a verified vMTB account.
//
// Why this exists
// ---------------
// jitsi-frontend has no login (anon key, persistSession: false) and the Jitsi
// prejoin display name is freely editable, so nothing it reports about who a
// participant is can be trusted. Instead the authenticated main app mints an
// opaque join ticket (create_meeting_join_ticket), the ticket rides on the
// meeting URL, and this function -- running server-side with the service-role
// key -- is the only thing that turns a ticket back into an identity.
//
// The browser never asserts who it is. It presents a ticket and a Jitsi
// participant id; every identity field written to meeting_participants is read
// here from profiles. A caller that forges display_name changes only what is
// shown on their own video tile, never the transcript.
//
// Actions
//   { action: "redeem", ticket }
//     -> { display_name, profession }   (to seed the prejoin box only)
//
//   { action: "bind", ticket, participant_id, meeting_session_id, display_name? }
//     -> { ok: true }
//
// The ticket is NOT consumed on bind -- it stays valid until expires_at so a
// refresh or a rejoin re-binds cleanly. meeting_participants already treats a
// rejoin as a new row.
//
// Deploy note: called from the unauthenticated jitsi-frontend, which attaches
// the anon key as its Authorization header (supabase-js does this
// automatically). No end-user JWT is involved or required.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Jitsi endpoint ids are short hex strings; cap hard rather than trusting input.
const PARTICIPANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface TicketRow {
  user_id: string;
  mtb_id: string;
  room_name: string;
  expires_at: string;
}

/** Look up a live ticket. Returns null for unknown, malformed or expired. */
async function loadTicket(token: unknown): Promise<TicketRow | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;

  const { data, error } = await supabaseAdmin
    .from("meeting_join_tickets")
    .select("user_id, mtb_id, room_name, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("ticket lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;

  return data as TicketRow;
}

/** The authoritative identity for a ticket, read from profiles. */
async function loadProfile(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("full_name, profession")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("profile lookup failed:", error.message);
    return null;
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;

  // --------------------------------------------------------------------
  // redeem -- cosmetic only: what to pre-fill the prejoin box with.
  // Deliberately returns nothing but the two display fields; never the
  // user id, email or mtb, so a leaked ticket cannot be used to enumerate
  // an account.
  // --------------------------------------------------------------------
  if (action === "redeem") {
    const ticket = await loadTicket(body.ticket);
    if (!ticket) return json({ error: "Invalid or expired ticket" }, 401);

    const profile = await loadProfile(ticket.user_id);
    if (!profile) return json({ error: "Profile not found" }, 404);

    return json({
      display_name: profile.full_name ?? null,
      profession: profile.profession ?? null,
    });
  }

  // --------------------------------------------------------------------
  // bind -- the actual security boundary. Writes the participant row with
  // identity taken from profiles, never from the request.
  // --------------------------------------------------------------------
  if (action === "bind") {
    const ticket = await loadTicket(body.ticket);
    if (!ticket) return json({ error: "Invalid or expired ticket" }, 401);

    const participantId = body.participant_id;
    const meetingSessionId = body.meeting_session_id;

    if (typeof participantId !== "string" || !PARTICIPANT_ID_RE.test(participantId)) {
      return json({ error: "Invalid participant_id" }, 400);
    }
    if (typeof meetingSessionId !== "string" || !meetingSessionId) {
      return json({ error: "Invalid meeting_session_id" }, 400);
    }

    // The session must belong to the same board the ticket was minted for.
    // Without this, a ticket for a board you are in could be redeemed against
    // a session for a board you are not.
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("meeting_sessions")
      .select("id, mtb_id")
      .eq("id", meetingSessionId)
      .maybeSingle();

    if (sessionError) {
      console.error("session lookup failed:", sessionError.message);
      return json({ error: "Could not verify meeting session" }, 500);
    }
    if (!session) return json({ error: "Unknown meeting session" }, 404);
    if (session.mtb_id !== ticket.mtb_id) {
      return json({ error: "Ticket does not match this meeting" }, 403);
    }

    const profile = await loadProfile(ticket.user_id);
    if (!profile) return json({ error: "Profile not found" }, 404);

    // display_name is what the participant chose to show on their tile. It is
    // recorded as-is for analytics and is explicitly NOT used for attribution.
    const chosenName =
      typeof body.display_name === "string" ? body.display_name.slice(0, 200) : null;

    const verified = {
      user_id: ticket.user_id,
      verified_name: profile.full_name ?? null,
      verified_profession: profile.profession ?? null,
      verified_at: new Date().toISOString(),
      display_name: chosenName,
      updated_at: new Date().toISOString(),
    };

    // A rejoin legitimately produces a second row, so match only an open one
    // (left_at IS NULL) for this session + participant before inserting.
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("meeting_participants")
      .select("id")
      .eq("meeting_session_id", meetingSessionId)
      .eq("participant_id", participantId)
      .is("left_at", null)
      .order("joined_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      console.error("participant lookup failed:", existingError.message);
      return json({ error: "Could not record participant" }, 500);
    }

    if (existing) {
      const { error } = await supabaseAdmin
        .from("meeting_participants")
        .update(verified)
        .eq("id", existing.id);
      if (error) {
        console.error("participant update failed:", error.message);
        return json({ error: "Could not record participant" }, 500);
      }
    } else {
      const { error } = await supabaseAdmin.from("meeting_participants").insert({
        meeting_session_id: meetingSessionId,
        participant_id: participantId,
        joined_at: new Date().toISOString(),
        ...verified,
      });
      if (error) {
        console.error("participant insert failed:", error.message);
        return json({ error: "Could not record participant" }, 500);
      }
    }

    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
