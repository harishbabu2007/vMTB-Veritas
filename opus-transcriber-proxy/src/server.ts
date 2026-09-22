import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import logger from './logger.js';
import { TranscriberProxy, type TranscriberProxyOptions } from './transcriberProxy.js';
import { createSTTProvider } from './stt/factory.js';
import { isValidSessionId } from './protocol.js';
import type { Config } from './config.js';
import type { TranscriptEvent } from './stt/types.js';
import type { ProviderName } from './stt/factory.js';

export interface ServerDeps {
  /** Called with every normalized transcript event (final + interim). */
  onTranscription?: (event: TranscriptEvent) => void;
  /**
   * Called when the session ends (JVB closed the socket). May be async; the
   * returned promise is awaited before the session is considered fully closed
   * only for process-level shutdown — the session itself emits 'closed' after
   * the STT drain, and handlers here should persist/publish idempotently.
   */
  onSessionClosed: (sessionId: string) => void | Promise<void>;
}

export interface ServerStats {
  activeSessions: number;
}

/**
 * HTTP + WebSocket server. Exposes:
 *   GET  /health   -> liveness probe (always 200)
 *   GET  /status   -> session stats (used to keep on-demand scaling decisions honest)
 *   WS   /transcribe?sessionId=...  -> JVB transcription endpoint
 */
export function createServer(config: Config, deps: ServerDeps): { server: http.Server; stats: ServerStats; close: () => Promise<void> } {
  const sessions = new Map<string, TranscriberProxy>();
  const stats: ServerStats = { activeSessions: 0 };

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active_sessions: sessions.size }));
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required: Expected WebSocket connection');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = `http://${request.headers.host ?? 'localhost'}${request.url}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid request URL');
      socket.destroy();
      return;
    }

    if (parsed.pathname !== '/transcribe') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nExpected /transcribe');
      socket.destroy();
      return;
    }

    const sessionId = parsed.searchParams.get('sessionId');
    if (!sessionId || !isValidSessionId(sessionId)) {
      logger.warn({ sessionId }, 'ws: rejecting connection, invalid sessionId');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid or missing sessionId');
      socket.destroy();
      return;
    }

    const providerName = (parsed.searchParams.get('provider') ?? config.provider) as ProviderName;

    wss.handleUpgrade(request, socket, head, (ws) => {
      const proxyOptions: TranscriberProxyOptions = {
        sessionId,
        provider: providerName,
        sampleRate: config.sttSampleRate,
        chunkMs: config.sttChunkMs,
        sttDrainTimeoutMs: config.sttDrainTimeoutMs,
        sttFactory: (tag) =>
          createSTTProvider(providerName, {
            sttWsUrl: config.sttWsUrl,
            sttUseIdToken: config.sttUseIdToken,
          }),
      };

      const session = new TranscriberProxy(ws, proxyOptions);

      session.on('transcription', (event) => {
        deps.onTranscription?.(event as TranscriptEvent);
      });

      session.on('closed', () => {
        sessions.delete(sessionId);
        stats.activeSessions = sessions.size;
        // Async: awaits pending segment inserts before publishing
        // meeting.completed so the worker never reads a partial snapshot.
        void Promise.resolve(deps.onSessionClosed(sessionId)).catch((err) => {
          logger.error(
            { sessionId, err: err instanceof Error ? err.message : String(err) },
            'session: onSessionClosed failed',
          );
        });
      });

      sessions.set(sessionId, session);
      stats.activeSessions = sessions.size;

      ws.addEventListener('error', (event) => {
        logger.warn({ sessionId }, 'ws: client error');
        void event;
      });

      logger.info({ sessionId, provider: providerName }, 'ws: transcription session opened');
    });
  });

  const close = async (): Promise<void> => {
    // Drain sessions (end-of-stream handshake) but never block shutdown
    // longer than the force-resolve window below.
    const sessionDrains = [...sessions.values()].map((session) => session.close());
    void Promise.allSettled(sessionDrains);
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
      setTimeout(resolve, 3000).unref();
    });
  };

  return { server, stats, close };
}