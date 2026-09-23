import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { SelfHostedSTTProvider } from '../src/stt/selfHosted.js';
import type { SttResult } from '../src/stt/types.js';

/** Minimal WhisperLive-compatible fake STT server for tests. */
function startFakeSttServer(onBinary?: (data: Buffer) => void) {
  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received: Buffer[] = [];
  const sent: string[] = [];

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        received.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        onBinary?.(received[received.length - 1]!);
      } else {
        sent.push(data.toString());
      }
    });
  });

  return new Promise<{
    send: (data: string) => void;
    socket: () => WebSocket | null;
    received: Buffer[];
    sent: string[];
    url: string;
    close: () => Promise<void>;
  }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no port');
      const url = `ws://127.0.0.1:${addr.port}/client/ws/speech`;
      let socket: WebSocket | null = null;
      const sockets = new Set<WebSocket>();
      wss.on('connection', (ws) => {
        socket = ws;
        sockets.add(ws);
      });
      resolve({
        send: (data: string) => socket?.send(data),
        socket: () => socket,
        received,
        sent,
        url,
        close: () => {
          for (const s of sockets) s.terminate();
          return new Promise<void>((r) => wss.close(() => { httpServer.close(() => r()); }));
        },
      });
    });
  });
}

describe('SelfHostedSTTProvider', () => {
  it('connects, forwards binary PCM and parses final results', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    const results: SttResult[] = [];
    provider.onResult = (r) => results.push(r);

    await provider.connect();
    const pcm = new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]);
    provider.sendAudio(pcm);

    await new Promise((r) => setTimeout(r, 50));
    expect(server.received.length).toBe(1);
    expect(server.received[0]!.equals(Buffer.from(pcm))).toBe(true);

    // Fake server sends a final result back.
    server.send(JSON.stringify({ message: 'final', transcript: 'hello world' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(results).toHaveLength(1);
    expect(results[0]!).toMatchObject({ text: 'hello world', isFinal: true });

    await provider.close();
    await server.close();
  });

  it('parses partial results too', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    const results: SttResult[] = [];
    provider.onResult = (r) => results.push(r);

    await provider.connect();
    server.send(JSON.stringify({ message: 'partial', transcript: 'hello' }));
    await new Promise((r) => setTimeout(r, 50));
    server.send(JSON.stringify({ message: 'final', transcript: 'hello world' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(results.map((r) => [r.isFinal, r.text])).toEqual([
      [false, 'hello'],
      [true, 'hello world'],
    ]);

    await provider.close();
    await server.close();
  });

  it('rejects connect when the server is unreachable (maxRetries=0)', async () => {
    const provider = new SelfHostedSTTProvider({ url: 'ws://127.0.0.1:1/client/ws/speech', maxRetries: 0 });
    await expect(provider.connect()).rejects.toThrow();
    await provider.close();
  });

  it('drops audio while disconnected without throwing', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    provider.sendAudio(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.received.length).toBe(0);
    await provider.close();
    await server.close();
  });

  it('sends end_of_stream and surfaces onEndOfStreamDone when acked', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    const finals: Array<{ text: string; isFinal: boolean }> = [];
    let eosDone = 0;
    provider.onResult = (r) => finals.push(r);
    provider.onEndOfStreamDone = () => {
      eosDone++;
    };

    await provider.connect();
    provider.sendEndOfStream();

    await new Promise((r) => setTimeout(r, 50));
    expect(server.sent).toContain(JSON.stringify({ message: 'end_of_stream' }));
    expect(eosDone).toBe(0); // not yet acked

    // Fake backend flushes final + acks.
    server.send(JSON.stringify({ message: 'final', transcript: 'tail words' }));
    server.send(JSON.stringify({ message: 'end_of_stream_done' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(finals).toEqual([{ text: 'tail words', isFinal: true }]);
    expect(eosDone).toBeGreaterThanOrEqual(1);

    await provider.close();
    await server.close();
  });

  it('resolves end-of-stream when the backend closes without an explicit ack', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    let eosDone = 0;
    provider.onEndOfStreamDone = () => {
      eosDone++;
    };

    await provider.connect();
    provider.sendEndOfStream();
    await new Promise((r) => setTimeout(r, 20));

    server.socket()?.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(eosDone).toBeGreaterThanOrEqual(1);

    await provider.close();
    await server.close();
  });

  it('stops reconnecting once closed', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 2, retryDelayMs: 20 });
    const onError = vi.fn();
    provider.onError = onError;

    await provider.connect();
    const sock = server.socket();
    expect(sock).not.toBeNull();
    const closed = once(sock!, 'close'); // register before provider.close() triggers it

    await provider.close(); // closed = true -> no reconnect allowed
    await closed;

    await new Promise((r) => setTimeout(r, 200)); // longer than any backoff window
    expect(onError).not.toHaveBeenCalled();
    await server.close();
  });

  it('fires onOpen on the initial connect', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 0 });
    const onOpen = vi.fn();
    provider.onOpen = onOpen;

    await provider.connect();
    expect(onOpen).toHaveBeenCalledTimes(1);

    await provider.close();
    await server.close();
  });

  it('fires onOpen again after a background reconnect', async () => {
    const server = await startFakeSttServer();
    const provider = new SelfHostedSTTProvider({ url: server.url, maxRetries: 3, retryDelayMs: 20 });
    const onOpen = vi.fn();
    provider.onOpen = onOpen;

    await provider.connect();
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Drop the server-side socket -> scheduleReconnect -> open succeeds -> onOpen #2.
    server.socket()?.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(onOpen).toHaveBeenCalledTimes(2);

    await provider.close();
    await server.close();
  });
});