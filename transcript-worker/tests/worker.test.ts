import { describe, expect, it, vi } from 'vitest';
import { parseMomJson } from '../src/llm.js';
import { buildArtifact, processMeeting } from '../src/worker.js';
import type { WorkerDeps } from '../src/worker.js';
import type { SegmentRow } from '../src/supabase.js';
import type { GcsClient } from '../src/gcs.js';

const segments: SegmentRow[] = [
  {
    meeting_id: 'm1',
    participant_id: 'p1',
    start_time: 10,
    end_time: 12,
    text: 'hello world',
    provider: 'self-hosted',
    created_at: '2026-08-20T00:00:00Z',
  },
  {
    meeting_id: 'm1',
    participant_id: 'p2',
    start_time: 12,
    end_time: 15,
    text: 'second speaker',
    provider: 'self-hosted',
    created_at: '2026-08-20T00:00:01Z',
  },
];

function makeDeps(overrides: Partial<WorkerDeps> = {}): { deps: WorkerDeps; fakes: Record<string, ReturnType<typeof vi.fn>> } {
  const fakes = {
    claim: vi.fn().mockResolvedValue({ meeting_id: 'm1', status: 'PENDING', transcript_object_key: null, error_message: null }),
    fetchSegments: vi.fn().mockResolvedValue(segments),
    resolveParticipantNames: vi.fn().mockResolvedValue(new Map<string, string | null>()),
    hasActiveSession: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
  };
  const gcs: GcsClient = { upload: fakes.upload };
  const deps: WorkerDeps = {
    supabase: {
      claim: fakes.claim,
      fetchSegments: fakes.fetchSegments,
      resolveParticipantNames: fakes.resolveParticipantNames,
      hasActiveSession: fakes.hasActiveSession,
      complete: fakes.complete,
      fail: fakes.fail,
    } as never,
    gcs,
    llm: { provider: 'none', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
    vm: { activatorUrl: '' },
    settle: () => Promise.resolve(),
    ...overrides,
  };
  return { deps, fakes };
}

describe('processMeeting', () => {
  it('completes the happy path: claim -> segments -> GCS -> complete', async () => {
    const { deps, fakes } = makeDeps();
    const outcome = await processMeeting('m1', deps, () => 1751979219000);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(fakes.claim).toHaveBeenCalledWith('m1');
    expect(fakes.fetchSegments).toHaveBeenCalledWith('m1');
    expect(fakes.upload).toHaveBeenCalledTimes(2);
    expect(fakes.upload).toHaveBeenCalledWith(
      'meetings/m1/transcript/transcript-v1.json',
      expect.stringContaining('hello world'),
      'application/json',
    );
    expect(fakes.upload).toHaveBeenCalledWith(
      'meetings/m1/transcript/transcript-v1.txt',
      '[Speaker 1] hello world\n\n[Speaker 2] second speaker',
      'text/plain',
    );
    expect(fakes.complete).toHaveBeenCalledWith('m1', 'meetings/m1/transcript/transcript-v1.json', 1, null);
    expect(fakes.fail).not.toHaveBeenCalled();
  });

  it('acks (already-processed) when no PENDING row exists', async () => {
    const { deps, fakes } = makeDeps();
    fakes.claim.mockResolvedValue(null);
    const outcome = await processMeeting('m1', deps);
    expect(outcome).toEqual({ kind: 'already-processed' });
    expect(fakes.fetchSegments).not.toHaveBeenCalled();
    expect(fakes.complete).not.toHaveBeenCalled();
  });

  it('marks FAILED and acks when GCS upload fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.upload.mockRejectedValue(new Error('storage quota exceeded'));
    const outcome = await processMeeting('m1', deps);
    expect(outcome).toEqual({ kind: 'failed', error: 'storage quota exceeded' });
    expect(fakes.fail).toHaveBeenCalledWith('m1', 'storage quota exceeded');
    expect(fakes.complete).not.toHaveBeenCalled();
  });

  it('marks FAILED and acks when the LLM step fails', async () => {
    const { deps, fakes } = makeDeps();
    const deps2 = {
      ...deps,
      llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('LLM unreachable')) as never;
    try {
      const outcome = await processMeeting('m1', deps2);
      expect(outcome).toEqual({ kind: 'failed', error: 'LLM unreachable' });
      expect(fakes.fail).toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('rethrows (nack) when the claim itself fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.claim.mockRejectedValue(new Error('db down'));
    await expect(processMeeting('m1', deps)).rejects.toThrow('db down');
    expect(fakes.fail).not.toHaveBeenCalled();
  });

  it('settles (waits) before fetching segments so stragglers land', async () => {
    const order: string[] = [];
    const { deps, fakes } = makeDeps({
      settle: async () => {
        order.push('settle');
      },
    });
    fakes.fetchSegments.mockImplementation(async () => {
      order.push('fetch');
      return segments;
    });
    const outcome = await processMeeting('m1', deps);
    expect(outcome).toEqual({ kind: 'completed' });
    expect(order).toEqual(['settle', 'fetch']);
  });

  it('invokes the LLM when configured and passes the MoM to complete', async () => {
    const { deps, fakes } = makeDeps({
      llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'The team reviewed the case.',
                decisions: ['Proceed with therapy A'],
                action_items: [{ owner: 'Dr X', task: 'Order NGS' }],
                discussion_points: ['Option B discussed'],
              }),
            },
          },
        ],
      }),
    }) as never;
    try {
      const outcome = await processMeeting('m1', deps);
      expect(outcome).toEqual({ kind: 'completed' });
      const mom = fakes.complete.mock.calls[0]![3];
      expect(mom).toMatchObject({ summary: 'The team reviewed the case.', model: 'gpt-4o-mini' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('parseMomJson', () => {
  it('parses plain JSON', () => {
    const out = parseMomJson('{"summary":"ok","decisions":[]}');
    expect(out.summary).toBe('ok');
  });

  it('strips markdown fences (Gemini sometimes wraps json_object output)', () => {
    const out = parseMomJson('```json\n{"summary":"ok","decisions":["a"]}\n```');
    expect(out.summary).toBe('ok');
    expect(out.decisions).toEqual(['a']);
  });

  it('extracts a JSON object even with surrounding prose', () => {
    const out = parseMomJson('Here are the minutes:\n{"summary":"ok"}\nHope that helps!');
    expect(out.summary).toBe('ok');
  });
});

describe('buildArtifact', () => {
  it('builds a versioned artifact with speaker labels and ordered text', () => {
    const artifact = buildArtifact('m1', segments, () => 1751979219000);
    expect(artifact.schema).toBe('vmtb-transcript/1');
    expect(artifact.version).toBe(1);
    expect(artifact.meeting_id).toBe('m1');
    expect(artifact.segment_count).toBe(2);
    // p1 appears first -> Speaker 1; p2 second -> Speaker 2
    expect(artifact.segments[0]!.speaker).toBe('Speaker 1');
    expect(artifact.segments[1]!.speaker).toBe('Speaker 2');
    expect(artifact.text).toBe('[Speaker 1] hello world\n\n[Speaker 2] second speaker');
    expect(artifact.generated_at).toBe(new Date(1751979219000).toISOString());
  });

  it('prefers resolved display names over numbered speakers', () => {
    const labels = new Map([
      ['p1', 'Dr. Patel'],
      ['p2', 'Dr. Lee'],
    ]);
    const artifact = buildArtifact('m1', segments, () => 1, labels);
    expect(artifact.segments[0]!.speaker).toBe('Dr. Patel');
    expect(artifact.segments[1]!.speaker).toBe('Dr. Lee');
    expect(artifact.text).toBe('[Dr. Patel] hello world\n\n[Dr. Lee] second speaker');
  });

  it('handles empty segment lists', () => {
    const artifact = buildArtifact('m1', [], () => 1);
    expect(artifact.segment_count).toBe(0);
    expect(artifact.text).toBe('');
  });

  it('resolves display names during processing and uses them in artifacts', async () => {
    const { deps, fakes } = makeDeps();
    fakes.resolveParticipantNames.mockResolvedValue(
      new Map([
        ['p1', 'Dr. Patel'],
        ['p2', null], // unresolved -> falls back to Speaker N
      ]),
    );
    const outcome = await processMeeting('m1', deps, () => 1751979219000);
    expect(outcome).toEqual({ kind: 'completed' });
    const txtUpload = fakes.upload.mock.calls.find((c) => c[0] === 'meetings/m1/transcript/transcript-v1.txt');
    expect(txtUpload?.[1]).toBe('[Dr. Patel] hello world\n\n[Speaker 2] second speaker');
  });
});
describe('automatic VM stop', () => {
  const ACT = 'https://activator.example';

  function withFetch(fn: typeof fetch): void {
    vi.stubGlobal('fetch', fn);
  }

  it('is disabled when JITSI_ACTIVATOR_URL is empty', async () => {
    const { deps } = makeDeps(); // vm.activatorUrl = ''
    const spy = vi.fn();
    withFetch(spy as unknown as typeof fetch);
    await processMeeting('m1', deps, () => 1751979219000);
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fires /stop-jitsi when the room is quiet', async () => {
    const { deps } = makeDeps({ vm: { activatorUrl: ACT } });
    fakesHas(deps, false);
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    withFetch(spy as unknown as typeof fetch);
    const outcome = await processMeeting('m1', deps, () => 1751979219000);
    expect(outcome).toEqual({ kind: 'completed' });
    expect(spy).toHaveBeenCalledWith(
      `${ACT}/stop-jitsi`,
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('skips the stop while another session is live', async () => {
    const { deps, fakes } = makeDeps({ vm: { activatorUrl: ACT } });
    fakes.hasActiveSession.mockResolvedValue(true);
    const spy = vi.fn();
    withFetch(spy as unknown as typeof fetch);
    await processMeeting('m1', deps, () => 1751979219000);
    expect(fakes.hasActiveSession).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not fail the meeting when the stop call throws', async () => {
    const { deps } = makeDeps({ vm: { activatorUrl: ACT } });
    fakesHas(deps, false);
    withFetch(vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch);
    const outcome = await processMeeting('m1', deps, () => 1751979219000);
    expect(outcome).toEqual({ kind: 'completed' });
    vi.unstubAllGlobals();
  });
});

function fakesHas(deps: WorkerDeps, value: boolean): void {
  (deps.supabase as unknown as { hasActiveSession: ReturnType<typeof vi.fn> })
    .hasActiveSession.mockResolvedValue(value);
}
