import logger from './logger.js';
import type { SupabaseStore, SegmentRow } from './supabase.js';
import type { GcsClient } from './gcs.js';
import type { LlmConfig } from './llm.js';
import { generateMom } from './llm.js';
import { assignSpeakers, groupBySpeaker, speakerLabel } from './speakers.js';

export const TRANSCRIPT_VERSION = 1;

export interface WorkerDeps {
  supabase: SupabaseStore;
  gcs: GcsClient;
  llm: LlmConfig;
  /** Teardown hook: when set, finished meetings stop the Jitsi VM. */
  vm?: { activatorUrl: string };
  /** Override the post-completion settle wait (tests pass a no-op). */
  settle?: () => Promise<void>;
}

/** Minutes of analytics silence that qualify the room as truly empty. */
const VM_ACTIVE_GRACE_MINUTES = 3;

/**
 * Grace period after meeting.completed before the first segment read.
 * The proxy awaits in-flight inserts before publishing, but this covers any
 * residual replication lag so the artifact is never missing the tail.
 */
const SEGMENT_SETTLE_MS = 3_000;

function defaultSettle(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, SEGMENT_SETTLE_MS);
    t.unref?.();
  });
}

export type Outcome =
  | { kind: 'completed' }
  | { kind: 'already-processed' }
  | { kind: 'failed'; error: string };

export interface TranscriptArtifact {
  schema: 'vmtb-transcript/1';
  meeting_id: string;
  version: number;
  generated_at: string;
  segment_count: number;
  segments: Array<{
    participant_id: string;
    speaker: string;
    start_time: number | null;
    end_time: number | null;
    text: string;
    provider: string | null;
  }>;
  text: string;
}

/**
 * One meeting.completed job:
 *   claim (idempotent) -> read segments -> upload artifacts to GCS ->
 *   generate MoM -> mark COMPLETED.
 *
 * Any processing error marks the row FAILED and is *acked* (HTTP 200): retrying
 * the same immutable meeting won't fix it, so we record the failure instead.
 * Only infra failures during the claim itself are left to Pub/Sub redelivery.
 */
export async function processMeeting(meetingId: string, deps: WorkerDeps, now = Date.now): Promise<Outcome> {
  let claimed;
  try {
    claimed = await deps.supabase.claim(meetingId);
  } catch (err) {
    // DB unavailable -> don't claim, let Pub/Sub redeliver.
    logger.error({ meetingId, err: err instanceof Error ? err.message : String(err) }, 'worker: claim failed');
    throw err;
  }

  if (!claimed) {
    logger.info({ meetingId }, 'worker: already processed or unknown; acking');
    await stopVmIfQuiet(meetingId, deps);
    return { kind: 'already-processed' };
  }

  try {
    // Let straggler segment inserts land before the single fetch below.
    // Tests inject a no-op; production waits SEGMENT_SETTLE_MS.
    await (deps.settle ?? defaultSettle)();
    const segments = await deps.supabase.fetchSegments(meetingId);

    // Resolve opaque participant tags to display names (best effort).
    let nameMap = new Map<string, string | null>();
    try {
      nameMap = await deps.supabase.resolveParticipantNames(segments);
    } catch (err) {
      logger.warn(
        { meetingId, err: err instanceof Error ? err.message : String(err) },
        'worker: name resolution failed; using Speaker N labels',
      );
    }
    const labels = assignSpeakers(segments, nameMap);

    const artifact = buildArtifact(meetingId, segments, now, labels);

    const objectKey = `meetings/${meetingId}/transcript/transcript-v${TRANSCRIPT_VERSION}.json`;
    await deps.gcs.upload(objectKey, JSON.stringify(artifact, null, 2), 'application/json');
    await deps.gcs.upload(
      `meetings/${meetingId}/transcript/transcript-v${TRANSCRIPT_VERSION}.txt`,
      artifact.text,
      'text/plain',
    );

    const mom = await generateMom(segments, deps.llm, undefined, labels);

    await deps.supabase.complete(meetingId, objectKey, TRANSCRIPT_VERSION, mom);
    logger.info({ meetingId, segments: segments.length, mom: Boolean(mom) }, 'worker: meeting completed');
    await stopVmIfQuiet(meetingId, deps);
    return { kind: 'completed' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ meetingId, err: error }, 'worker: processing failed, marking FAILED');
    await deps.supabase.fail(meetingId, error);
    await stopVmIfQuiet(meetingId, deps);
    return { kind: 'failed', error };
  }
}

/**
 * Automatic VM teardown: once a meeting has been fully processed, ask the
 * activation backend to stop the Jitsi VM so an idle machine never bills
 * overnight. Never throws - a teardown failure must not affect the meeting's
 * outcome (which is already recorded).
 *
 * Safety valve: if any analytics session still has a fresh heartbeat, someone
 * is mid-meeting (perhaps a newer one) and the stop is skipped.
 */
export async function stopVmIfQuiet(meetingId: string, deps: WorkerDeps): Promise<void> {
  const activatorUrl = deps.vm?.activatorUrl?.replace(/\/$/, '');
  if (!activatorUrl) {
    logger.debug({ meetingId }, 'vm: JITSI_ACTIVATOR_URL not set, skipping VM stop');
    return;
  }

  try {
    const active = await deps.supabase.hasActiveSession(VM_ACTIVE_GRACE_MINUTES);
    if (active) {
      logger.info({ meetingId }, 'vm: live session detected, skipping VM stop');
      return;
    }
  } catch (err) {
    logger.warn(
      { meetingId, err: err instanceof Error ? err.message : String(err) },
      'vm: active-session check failed, skipping VM stop conservatively',
    );
    return;
  }

  try {
    const res = await fetch(`${activatorUrl}/stop-jitsi`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      logger.info({ meetingId, status: res.status }, 'vm: /stop-jitsi fired successfully');
    } else {
      logger.warn({ meetingId, status: res.status }, 'vm: /stop-jitsi returned non-ok status');
    }
  } catch (err) {
    logger.warn(
      { meetingId, err: err instanceof Error ? err.message : String(err) },
      'vm: /stop-jitsi call failed',
    );
  }
}

export function buildArtifact(
  meetingId: string,
  segments: SegmentRow[],
  now: () => number = Date.now,
  labels?: Map<string, string>,
): TranscriptArtifact {
  const resolved = labels ?? assignSpeakers(segments);
  const normalized = segments.map((s) => ({
    participant_id: s.participant_id,
    speaker: speakerLabel(resolved, s.participant_id),
    start_time: s.start_time,
    end_time: s.end_time,
    text: s.text,
    provider: s.provider,
  }));
  // Readable form: consecutive same-speaker fragments stitched into paragraphs.
  const lines = groupBySpeaker(segments, resolved);
  return {
    schema: 'vmtb-transcript/1',
    meeting_id: meetingId,
    version: TRANSCRIPT_VERSION,
    generated_at: new Date(now()).toISOString(),
    segment_count: normalized.length,
    segments: normalized,
    text: lines.map((l) => `[${l.speaker}] ${l.text}`).join('\n\n'),
  };
}