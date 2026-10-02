import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { debugLog } from '../utils/sanitization'

/**
 * Server-verified speaker identity.
 *
 * This page has no login (anon key, persistSession: false) and the Jitsi prejoin
 * display name is freely editable, so nothing this page asserts about who the
 * participant is can be trusted. Instead the authenticated main app mints an
 * opaque join ticket bound to auth.uid(), the ticket rides on the meeting URL,
 * and the meeting_participant_identity Edge Function -- running with the
 * service-role key -- is the only thing that turns a ticket back into a
 * profile.
 *
 * Two actions, and nothing else may change identity here:
 *   redeem { ticket }                          -> { display_name, profession }
 *   bind   { ticket, participant_id, meeting_session_id, display_name? }
 *
 * The name and profession returned by redeem are cosmetic: they only seed the
 * editable prejoin box. The binding happens in bind, server-side.
 *
 * Every call here is fail-soft. A meeting must be joinable even when this
 * endpoint is unreachable -- the cost of a failure is an unprefilled prejoin
 * box (or, for bind, an unverified speaker label), never a broken meeting.
 */

const FUNCTION_NAME = 'meeting_participant_identity'

/**
 * Cap the identity round trip. redeem is on the critical path to the prejoin
 * screen, so it must not be able to hang the page open.
 */
const REQUEST_TIMEOUT_MS = 5000

export interface VerifiedIdentity {
  displayName: string | null
  profession: string | null
}

/**
 * Combine a verified name and profession into the Jitsi prejoin display name,
 * e.g. "Dr. Priya Sharma (Medical Oncologist)".
 *
 * Undefined when there is no name at all: the prejoin box then starts empty and
 * the participant types their own, which is the correct outcome for an account
 * with no full_name on file.
 */
export function formatPrejoinDisplayName(
  name: string | null | undefined,
  profession: string | null | undefined,
): string | undefined {
  const trimmedName = name?.trim()
  if (!trimmedName) return undefined
  const trimmedProfession = profession?.trim()
  return trimmedProfession ? `${trimmedName} (${trimmedProfession})` : trimmedName
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Exchange a ticket for the display name and profession to prefill prejoin with.
 * Returns null when there is no ticket, Supabase is unconfigured, or the call
 * fails for any reason.
 */
export async function redeemTicket(ticket: string | null): Promise<VerifiedIdentity | null> {
  const supabase = ticket ? getSupabaseClient() : null
  if (!ticket || !supabase || !isSupabaseConfigured()) {
    debugLog('[IDENTITY] No ticket or Supabase not configured; cannot redeem')
    return null
  }

  try {
    // supabase-js attaches the anon key as the Authorization header, which this
    // endpoint requires. A bare fetch() would not.
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      method: 'POST',
      body: { action: 'redeem', ticket },
      timeout: REQUEST_TIMEOUT_MS,
    })

    if (error) {
      debugLog('[IDENTITY] redeem failed:', error.message)
      return null
    }

    const body = (data ?? {}) as { display_name?: unknown; profession?: unknown }
    return {
      displayName: readString(body.display_name),
      profession: readString(body.profession),
    }
  } catch (err) {
    debugLog('[IDENTITY] redeem threw:', err)
    return null
  }
}

/**
 * Bind the ticket to this Jitsi participant so the server records who actually
 * spoke. This is the call that writes meeting_participants -- the browser no
 * longer does.
 *
 * `displayName` is what the participant chose to show on their tile. It is
 * recorded for analytics and explicitly not used for attribution.
 *
 * Requires meetingSessionId: the endpoint rejects a bind whose session is
 * missing or belongs to a different MTB than the ticket was minted for, so this
 * must be called only once meetingAnalytics has created/joined the session.
 * Returns false when there is nothing to bind (no ticket, no session) or the
 * call fails; the caller logs and carries on, leaving the speaker unverified.
 */
export async function bindTicketIdentity(args: {
  ticket: string | null
  participantId: string
  meetingSessionId: string | null
  displayName?: string | null
}): Promise<boolean> {
  const { ticket, participantId, meetingSessionId, displayName } = args

  if (!ticket) return false
  if (!meetingSessionId) {
    debugLog('[IDENTITY] bind skipped: no meeting session yet')
    return false
  }
  const supabase = getSupabaseClient()
  if (!supabase || !isSupabaseConfigured()) {
    debugLog('[IDENTITY] Supabase not configured, cannot bind ticket')
    return false
  }

  try {
    const { error } = await supabase.functions.invoke(FUNCTION_NAME, {
      method: 'POST',
      body: {
        action: 'bind',
        ticket,
        participant_id: participantId,
        meeting_session_id: meetingSessionId,
        display_name: displayName ?? null,
      },
      timeout: REQUEST_TIMEOUT_MS,
    })

    if (error) {
      debugLog('[IDENTITY] bind failed:', error.message)
      return false
    }

    debugLog('[IDENTITY] bind ok')
    return true
  } catch (err) {
    debugLog('[IDENTITY] bind threw:', err)
    return false
  }
}