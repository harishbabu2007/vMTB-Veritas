export function deriveRoomName(mtbName: string): string {
  return mtbName.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

export function buildMeetingUrl(
  mtb: { id: string; name: string },
  viewer?: { name?: string | null; profession?: string | null }
): string {
  const roomName = deriveRoomName(mtb.name);
  const baseUrl = import.meta.env.VITE_SERVER_LOADER_URL || 'https://meeting-vmtb-v2.3billionpairs.com';
  const params = new URLSearchParams({ room: roomName, mtb_id: mtb.id, mtb_name: mtb.name });
  // Carry the joining user's profile so the meeting pre-join screen can be
  // prefilled with "Name (Role)" instead of asking for a name.
  const name = viewer?.name?.trim();
  if (name) {
    params.set('name', name);
    const role = viewer?.profession?.trim();
    if (role) params.set('role', role);
  }
  return `${baseUrl}?${params}`;
}
