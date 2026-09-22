import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TranscriberProxy } from '../src/transcriberProxy.js';
import type { STTProvider, SttResult, TranscriptEvent } from '../src/stt/types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

class FakeWebSocket {
  static OPEN = 1;
  OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, cb: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, cb: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== cb),
    );
  }
  send(data: string): void {
    this.sent.push(data);
  }
  emit(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  close(): void {
    this.readyState = 3;
  }
}

class ControllableSTT implements STTProvider {
  onResult?: (result: SttResult) => void;
  onError?: (err: Error) => void;
  onEndOfStreamDone?: () => void;
  connected = false;
  received: Uint8Array[] = [];
  eosSent = false;
  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  sendAudio(pcm16: Uint8Array): void {
    this.received.push(pcm16);
  }
  sendEndOfStream(): void {
    this.eosSent = true;
    // Simulate a backend that flushes a final then acks EOS.
    this.onResult?.({ text: 'drain final', isFinal: true });
    this.onEndOfStreamDone?.();
  }
  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  fireResult(text: string, isFinal: boolean): void {
    this.onResult?.({ text, isFinal });
  }
}

function makeProxy(overrides?: Partial<Parameters<typeof TranscriberProxy.prototype.constructor>[1]>) {
  const ws = new FakeWebSocket();
  const stt = new ControllableSTT();
  const events: TranscriptEvent[] = [];
  const factory = vi.fn(() => stt);

  const proxy = new TranscriberProxy(ws, {
    sessionId: 'meeting-1',
    provider: 'test',
    sampleRate: 16000,
    chunkMs: 60,
    sttFactory: factory,
    ...overrides,
  });
  proxy.on('transcription', (e) => events.push(e as TranscriptEvent));

  return { ws, stt, events, factory, proxy };
}

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TranscriberProxy', () => {
  it('replies to pings', () => {
    const { ws, proxy } = makeProxy();
    ws.emit('message', { data: JSON.stringify({ event: 'ping', id: 42 }) });
    const pong = ws.sent.find((m) => m.includes('"pong"'));
    expect(pong).toBeTruthy();
    expect(JSON.parse(pong!)).toEqual({ event: 'pong', id: 42 });
    proxy.close();
  });

  it('creates one STT connection per participant tag', async () => {
    const { ws, proxy, factory } = makeProxy();
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(proxy.activeParticipants).toBe(1);
    proxy.close();
  });

  it('decodes audio and emits final transcript events with monotonic times', async () => {
    const { ws, stt, events, proxy } = makeProxy();

    const framesText = await readFile(join(fixturesDir, 'sine_opus_frames.b64'), 'utf8');
    const frames = framesText
      .split('\n')
      .filter(Boolean)
      .map((l) => Buffer.from(l, 'base64'));

    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(100);

    // Feed a few frames to trigger at least one forward chunk (60ms @ 16k).
    for (let i = 0; i < 5; i++) {
      ws.emit('message', {
        data: JSON.stringify({
          event: 'media',
          media: { tag: 'p1', chunk: i, timestamp: i * 20, payload: frames[i]!.toString('base64') },
        }),
      });
    }
    await waitFor(300);

    expect(stt.received.length).toBeGreaterThan(0);
    const firstAudio = stt.received[0]!;
    expect(firstAudio.byteLength % 2).toBe(0);
    expect(firstAudio.byteLength / 2).toBe(16000 * 0.06); // 60ms chunk

    stt.fireResult('interim words', false);
    stt.fireResult('final words', true);
    await waitFor(50);

    const finals = events.filter((e) => e.isFinal);
    expect(finals).toHaveLength(1);
    const final = finals[0]!;
    expect(final.meetingId).toBe('meeting-1');
    expect(final.participantId).toBe('p1');
    expect(final.text).toBe('final words');
    expect(final.endTime).toBeGreaterThanOrEqual(final.startTime);
    expect(final.provider).toBe('test');

    proxy.close();
  }, 20000);

  it('does not persist interim events to the emit stream as finals (isFinal preserved)', async () => {
    const { ws, stt, events, proxy } = makeProxy();
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);
    stt.fireResult('partial text', false);
    await waitFor(20);
    expect(events).toHaveLength(1);
    expect(events[0]!.isFinal).toBe(false);
    expect(events[0]!.text).toBe('partial text');
    proxy.close();
  });

  it('emits closed exactly once when the socket closes', async () => {
    const { ws, proxy } = makeProxy();
    let closed = 0;
    proxy.on('closed', () => closed++);
    ws.emit('close', {});
    ws.emit('close', {});
    await waitFor(50);
    expect(closed).toBe(1);
    expect(proxy.activeParticipants).toBe(0);
  });

  it('sends end_of_stream and waits for the final before emitting closed', async () => {
    const { ws, stt, events, proxy } = makeProxy();
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);

    const order: string[] = [];
    proxy.on('closed', () => order.push('closed'));
    stt.onResult = ((orig?: typeof stt.onResult) => (r: SttResult) => {
      if (r.isFinal) order.push('final');
      orig?.(r);
    })(stt.onResult);

    ws.emit('close', {});
    await waitFor(50);

    expect(stt.eosSent).toBe(true);
    expect(order).toEqual(['final', 'closed']);
    const finals = events.filter((e) => e.isFinal && e.text === 'drain final');
    expect(finals).toHaveLength(1);
  });

  it('still closes when the STT never acknowledges end-of-stream (bounded wait)', async () => {
    const sttSilent = new ControllableSTT();
    sttSilent.sendEndOfStream = () => {
      sttSilent.eosSent = true;
      // never acks
    };
    const { ws, proxy } = makeProxy({ sttFactory: () => sttSilent, sttDrainTimeoutMs: 50 });
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);

    let closed = 0;
    proxy.on('closed', () => closed++);
    ws.emit('close', {});
    await waitFor(150);
    expect(closed).toBe(1);
    expect(sttSilent.eosSent).toBe(true);
  });

  it('echoes final results back to JVB as transcription-result', async () => {
    const { ws, stt, proxy } = makeProxy();
    ws.emit('message', { data: JSON.stringify({ event: 'start', start: { tag: 'p1' } }) });
    await waitFor(50);
    stt.fireResult('final words', true);
    await waitFor(20);
    const echoed = ws.sent.find((m) => m.includes('"transcription-result"'));
    expect(echoed).toBeTruthy();
    const parsed = JSON.parse(echoed!);
    expect(parsed.is_interim).toBe(false);
    expect(parsed.participant).toEqual({ id: 'p1' });
    expect(parsed.transcript[0]!.text).toBe('final words');
    proxy.close();
  });
});