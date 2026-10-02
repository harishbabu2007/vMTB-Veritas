import type { SegmentRow, SpeakerIdentity } from './supabase.js';

/**
 * Assign display labels to the opaque JVB participant tags, in order of first
 * appearance.
 *
 * A verified speaker is labelled "Name, Profession" from their vMTB account,
 * which is what makes a clinical transcript readable: you can tell an
 * oncologist's opinion from a pathologist's without guessing. A speaker with
 * no verified row is labelled "Speaker N - unverified" rather than being given
 * whatever they typed into the Jitsi prejoin box, so attributed and unattributed
 * speech stay visibly distinct on the face of the record.
 *
 * Numbering is global across the meeting, so the same unverified speaker keeps
 * the same number everywhere it appears.
 */
export function assignSpeakers(
  segments: SegmentRow[],
  identities?: Map<string, SpeakerIdentity | null>,
): Map<string, string> {
  const order: string[] = [];
  for (const s of [...segments].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0))) {
    const id = s.participant_id ?? '';
    if (id && !order.includes(id)) order.push(id);
  }
  return new Map(
    order.map((id, i) => {
      const identity = identities?.get(id);
      return [id, identity ? formatIdentity(identity) : `Speaker ${i + 1} - unverified`];
    }),
  );
}

/** "Priya Sharma, Medical oncologist" -- profession alone if the profile has none. */
function formatIdentity(identity: SpeakerIdentity): string {
  const name = identity.name.trim();
  const profession = identity.profession?.trim();
  return profession ? `${name}, ${profession}` : name;
}

export function speakerLabel(labels: Map<string, string>, participantId: string | null): string {
  return (participantId && labels.get(participantId)) || 'Unknown';
}

export interface SpeakerLine {
  speaker: string;
  text: string;
}

/**
 * Merge consecutive segments from the same speaker into single flowing
 * utterances. The streaming STT commits small fragments (with occasional
 * echo artifacts); stitching them per speaker turns the raw segment list
 * into readable paragraphs for artifacts and MoM prompts.
 */
export function groupBySpeaker(
  segments: SegmentRow[],
  labels: Map<string, string>,
): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  for (const s of [...segments].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0))) {
    const speaker = speakerLabel(labels, s.participant_id);
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${s.text}`.replace(/\s+/g, ' ').trim();
    } else {
      lines.push({ speaker, text: s.text });
    }
  }
  return lines;
}
