// Helper functions for URL and logging

export interface MeetingUrlParams {
  roomName: string | null;
  mtbId: string | null;
  mtbName: string | null;
  /**
   * Opaque join ticket minted by the main app and bound to the real account
   * server-side. The only thing this page is allowed to know about the user.
   */
  ticket: string | null;
  /**
   * Transitional only: the old ?name=/?role= params, used when no ticket is
   * present so links minted before the ticket flow still prefill the prejoin
   * box. These values are self-asserted and unverified -- nothing derived from
   * them is ever trusted for transcript attribution.
   */
  legacyName: string | null;
  legacyRole: string | null;
  returnUrl: string;
}

/**
 * Mirrors the token shape the meeting_participant_identity Edge Function
 * accepts (/^[a-f0-9]{64}$/). Checked here purely to avoid a pointless network
 * round trip on a malformed or tampered param; the function re-validates.
 */
const TICKET_RE = /^[a-f0-9]{64}$/;

export function sanitizeRoomName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100)
}

export function getRoomNameFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const room = params.get('room')
  return room ? sanitizeRoomName(room) : null
}

/**
 * Get all meeting parameters from URL
 * Expected URL format: ?room=mtb-xyz&mtb_id=uuid&mtb_name=Board%20Name&ticket=<64 hex>
 *
 * The name and profession used to travel as ?name=/?role= and were concatenated
 * client-side into the prejoin display name, which the prejoin box let the user
 * edit -- so whatever ended up in the transcript was a self-asserted string. The
 * ticket replaces them: the server reads the real name and profession from
 * profiles. The legacy params are still read as a fallback for links minted
 * before that change, and are never trusted for attribution.
 */
export function getMeetingParamsFromUrl(): MeetingUrlParams {
  const params = new URLSearchParams(window.location.search)
  
  const room = params.get('room')
  const mtbId = params.get('mtb_id')
  const mtbName = params.get('mtb_name')
  // URLSearchParams.get already URL-decodes.
  const ticket = params.get('ticket')?.trim() || null
  const legacyName = params.get('name')
  const legacyRole = params.get('role')
  const returnUrl = params.get('returnUrl')
  
  return {
    roomName: room ? sanitizeRoomName(room) : null,
    mtbId: mtbId || null,
    mtbName: mtbName ? decodeURIComponent(mtbName) : null,
    ticket: ticket && TICKET_RE.test(ticket) ? ticket : null,
    legacyName: legacyName?.trim() || null,
    legacyRole: legacyRole?.trim() || null,
    returnUrl: returnUrl || import.meta.env.VITE_MAIN_APP_URL || 'https://vmtb-v2.3billionpairs.com',
  }
}

export function getReturnUrl(): string {
  const params = new URLSearchParams(window.location.search)
  const returnUrl = params.get('returnUrl')
  return returnUrl || import.meta.env.VITE_MAIN_APP_URL || 'https://vmtb-v2.3billionpairs.com'
}

export function debugLog(message: string, data?: unknown): void {
  if (import.meta.env.VITE_DEBUG === 'true') {
    console.log(`[JITSI-FRONTEND] ${message}`, data || '')
  }
}
