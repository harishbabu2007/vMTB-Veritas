import { describe, expect, it } from 'vitest';
import { SupabaseStore } from '../src/supabase.js';
import type { SegmentRow } from '../src/supabase.js';
import { assignSpeakers } from '../src/speakers.js';

/**
 * resolveParticipantNames is the boundary where an opaque JVB audio-channel tag
 * becomes a name on a clinical record, so it is worth pinning down directly:
 * which columns are read, which rows are eligible, and what happens when the
 * answer is "we cannot tell".
 */

const segments: SegmentRow[] = [
  {
    meeting_id: 'm1',
    participant_id: '9f4a4375-a0',
    start_time: 100,
    end_time: 200,
    text: 'hello',
    provider: 'self-hosted',
    created_at: '2026-08-20T00:00:00Z',
  },
];

interface ChainCall {
  table: string;
  op: string;
  arg?: unknown;
  value?: unknown;
}

/** Minimal stand-in for the supabase-js fluent query builder. */
function fakeClient(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const calls: ChainCall[] = [];
  const client = {
    from(table: string) {
      const result = tables[table] ?? {};
      const chain: Record<string, unknown> = {};
      for (const op of ['select', 'in', 'not', 'gte', 'limit']) {
        chain[op] = (arg?: unknown, value?: unknown) => {
          calls.push({ table, op, arg, value });
          return chain;
        };
      }
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(onFulfilled);
      return chain;
    },
  };
  return { client: client as never, calls };
}

const verifiedRow = {
  participant_id: '9f4a4375',
  verified_name: 'Priya Sharma',
  verified_profession: 'Medical oncologist',
  user_id: 'u-onc',
  meeting_session_id: 's-overlap',
  joined_at: '2026-08-20T00:00:00Z',
};

// Transcript window is [100s, 200s] +/- 60s skew, i.e. 40s..260s epoch.
const overlappingSession = { id: 's-overlap', started_at: new Date(60_000).toISOString(), ended_at: null };
const staleSession = { id: 's-stale', started_at: new Date(0).toISOString(), ended_at: new Date(30_000).toISOString() };

describe('resolveParticipantNames', () => {
  it('resolves a verified identity for the original -a0 tag', async () => {
    const { client } = fakeClient({
      meeting_participants: { data: [verifiedRow] },
      meeting_sessions: { data: [overlappingSession] },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    const result = await store.resolveParticipantNames(segments);

    expect(result.get('9f4a4375-a0')).toEqual({
      name: 'Priya Sharma',
      profession: 'Medical oncologist',
      userId: 'u-onc',
    });
  });

  it('fails closed: filters on verified_name, never on display_name', async () => {
    const { client, calls } = fakeClient({ meeting_participants: { data: [] } });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    await store.resolveParticipantNames(segments);

    const select = calls.find((c) => c.op === 'select' && c.table === 'meeting_participants');
    expect(String(select?.arg)).toContain('verified_name');
    expect(String(select?.arg)).toContain('verified_profession');
    expect(String(select?.arg)).toContain('user_id');
    // The prejoin display name is self-asserted text and must never be read.
    expect(String(select?.arg)).not.toContain('display_name');

    const not = calls.find((c) => c.op === 'not' && c.table === 'meeting_participants');
    expect(not).toMatchObject({ arg: 'verified_name', value: 'is' });
  });

  it('matches on the endpoint id with the audio-channel suffix stripped', async () => {
    const { client, calls } = fakeClient({
      meeting_participants: { data: [verifiedRow] },
      meeting_sessions: { data: [overlappingSession] },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    await store.resolveParticipantNames(segments);

    expect(calls.find((c) => c.op === 'in' && c.table === 'meeting_participants')?.value).toEqual([
      '9f4a4375',
    ]);
  });

  it('ignores participants whose session does not overlap the transcript window', async () => {
    const { client } = fakeClient({
      meeting_participants: { data: [{ ...verifiedRow, meeting_session_id: 's-stale' }] },
      meeting_sessions: { data: [staleSession] },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    const result = await store.resolveParticipantNames(segments);

    expect(result.get('9f4a4375-a0')).toBeNull();
  });

  it('skips a row whose verified_name is blank', async () => {
    const { client } = fakeClient({
      meeting_participants: { data: [{ ...verifiedRow, verified_name: '   ' }] },
      meeting_sessions: { data: [overlappingSession] },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    const result = await store.resolveParticipantNames(segments);

    expect(result.get('9f4a4375-a0')).toBeNull();
  });

  it('prefers the newest row for an endpoint id', async () => {
    const { client } = fakeClient({
      meeting_participants: {
        data: [
          { ...verifiedRow, verified_name: 'Older', joined_at: '2026-08-20T00:00:00Z' },
          { ...verifiedRow, verified_name: 'Newer', joined_at: '2026-08-20T01:00:00Z' },
        ],
      },
      meeting_sessions: { data: [overlappingSession] },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    const result = await store.resolveParticipantNames(segments);

    expect(result.get('9f4a4375-a0')).toMatchObject({ name: 'Newer' });
  });

  it('fails closed rather than throwing when the query fails', async () => {
    const { client } = fakeClient({
      meeting_participants: { error: { message: 'boom' } },
    });
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    const result = await store.resolveParticipantNames(segments);

    // A failed resolution must attribute nothing. (The map is left empty rather
    // than filled with explicit nulls; both read as "unverified" downstream.)
    expect(result.size).toBe(0);
    expect(assignSpeakers(segments, result).get('9f4a4375-a0')).toBe('Speaker 1 - unverified');
  });

  it('short-circuits on empty input', async () => {
    const { client, calls } = fakeClient({});
    const store = new SupabaseStore('https://x.supabase.co', 'service-role', client);

    expect((await store.resolveParticipantNames([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});