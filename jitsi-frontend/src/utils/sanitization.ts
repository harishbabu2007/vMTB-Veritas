// Helper functions for URL and logging

export interface MeetingUrlParams {
  roomName: string | null;
  mtbId: string | null;
  mtbName: string | null;
  displayName: string | null;
  displayRole: string | null;
  returnUrl: string;
}

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
 * Expected URL format: ?room=mtb-xyz&mtb_id=uuid&mtb_name=Board%20Name&name=Dr%20X&role=Oncologist
 */
export function getMeetingParamsFromUrl(): MeetingUrlParams {
  const params = new URLSearchParams(window.location.search)
  
  const room = params.get('room')
  const mtbId = params.get('mtb_id')
  const mtbName = params.get('mtb_name')
  // URLSearchParams.get already URL-decodes.
  const displayName = params.get('name')
  const displayRole = params.get('role')
  const returnUrl = params.get('returnUrl')
  
  return {
    roomName: room ? sanitizeRoomName(room) : null,
    mtbId: mtbId || null,
    mtbName: mtbName ? decodeURIComponent(mtbName) : null,
    displayName: displayName?.trim() || null,
    displayRole: displayRole?.trim() || null,
    returnUrl: returnUrl || import.meta.env.VITE_MAIN_APP_URL || 'https://vmtb-v2.3billionpairs.com',
  }
}

/**
 * Combine the profile name and role into the meeting display name,
 * e.g. "Dr. Priya Sharma (Medical Oncologist)".
 */
export function buildDisplayName(name: string | null, role: string | null): string | undefined {
  const trimmedName = name?.trim()
  if (!trimmedName) return undefined
  const trimmedRole = role?.trim()
  return trimmedRole ? `${trimmedName} (${trimmedRole})` : trimmedName
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
