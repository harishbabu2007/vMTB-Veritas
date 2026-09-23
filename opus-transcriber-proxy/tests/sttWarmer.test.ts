import { describe, expect, it, vi } from 'vitest';
import { SttWarmer, httpOriginFromWsUrl } from '../src/sttWarmer.js';

describe('httpOriginFromWsUrl', () => {
  it('maps ws and wss to http/https origins', () => {
    expect(httpOriginFromWsUrl('ws://stt:9090/client/ws/speech')).toBe('http://stt:9090');
    expect(httpOriginFromWsUrl('wss://stt.example.com/client/ws/speech')).toBe('https://stt.example.com');
  });

  it('returns null for garbage', () => {
    expect(httpOriginFromWsUrl('not a url')).toBeNull();
  });
});

describe('SttWarmer', () => {
  it('pings immediately on start and on the interval', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    const warmer = new SttWarmer({
      readyUrl: 'http://stt.example/ready',
      useIdToken: false,
      intervalMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    warmer.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 80));
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);

    warmer.stop();
    const afterStop = fetchImpl.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchImpl.mock.calls.length).toBe(afterStop);
  });

  it('does not throw when the ping fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('cold'));
    const warmer = new SttWarmer({
      readyUrl: 'http://stt.example/ready',
      useIdToken: false,
      intervalMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    warmer.start();
    await new Promise((r) => setTimeout(r, 20));
    warmer.stop();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
