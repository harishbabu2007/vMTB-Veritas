import { supabase } from '../Supabase/client';

export function deriveRoomName(mtbName: string): string {
  return mtbName.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

/**
 * Build the meeting URL, minting a server-side join ticket for the current user.
 *
 * The URL deliberately carries NO name or profession any more. Those used to be
 * passed as ?name=/?role=, concatenated client-side into the Jitsi prejoin
 * display name, and written straight into meeting_participants -- which made the
 * transcript's speaker attribution a self-asserted, editable string. The ticket
 * replaces them: jitsi-frontend redeems it for the prejoin prefill, then binds it
 * to the Jitsi participant id so the server, not the browser, records who spoke.
 * Dropping the two params also keeps personal data out of browser history and
 * Referer headers.
 *
 * Throws when the ticket cannot be minted -- including when the caller is not a
 * member of this MTB, which create_meeting_join_ticket now enforces server-side.
 * Callers surface the message; we deliberately do NOT fall back to a ticketless
 * URL, because that would silently produce an unattributed transcript.
 */
export async function buildMeetingUrl(mtb: { id: string; name: string }): Promise<string> {
  const roomName = deriveRoomName(mtb.name);
  const baseUrl = import.meta.env.VITE_SERVER_LOADER_URL || 'https://meeting-vmtb-v2.3billionpairs.com';

  const { data: ticket, error } = await supabase.rpc('create_meeting_join_ticket', {
    p_mtb_id: mtb.id,
    p_room_name: roomName,
  });

  if (error) throw new Error(error.message || 'Could not prepare the meeting.');
  if (!ticket || typeof ticket !== 'string') throw new Error('Could not prepare the meeting.');

  const params = new URLSearchParams({
    room: roomName,
    mtb_id: mtb.id,
    mtb_name: mtb.name,
    ticket,
  });
  return `${baseUrl}?${params}`;
}

/**
 * Open the meeting in a new tab from a click handler.
 *
 * The blank tab is opened synchronously and its location set afterwards:
 * calling window.open() *after* an await detaches it from the user gesture, so
 * browsers treat it as a pop-up and block it.
 *
 * Returns null on success, or a user-facing message to show on failure.
 */
export async function openMeetingTab(mtb: { id: string; name: string }): Promise<string | null> {
  const tab = window.open('', '_blank');
  if (!tab) {
    return 'Your browser blocked the meeting window. Allow pop-ups for this site and try again.';
  }

  try {
    tab.location.href = await buildMeetingUrl(mtb);
    return null;
  } catch (err) {
    tab.close();
    return err instanceof Error ? err.message : 'Could not start the meeting. Please try again.';
  }
}
