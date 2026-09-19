export function deriveRoomName(mtbName: string): string {
  return mtbName.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

export function buildMeetingUrl(mtb: { id: string; name: string }): string {
  const roomName = deriveRoomName(mtb.name);
  const baseUrl = import.meta.env.VITE_SERVER_LOADER_URL || 'https://meeting-vmtb-v2.3billionpairs.com';
  return `${baseUrl}?${new URLSearchParams({ room: roomName, mtb_id: mtb.id, mtb_name: mtb.name })}`;
}
