import WebSocket, { type ErrorEvent } from 'ws';
import logger from '../logger.js';
import type { STTProvider, SttResult } from './types.js';

export interface SelfHostedOptions {
  /** WebSocket URL of the STT service, e.g. ws://stt:9090/client/ws/speech */
  url: string;
  /** Number of connection attempts before giving up. */
  maxRetries?: number;
  /** Base delay for reconnect backoff (ms). */
  retryDelayMs?: number;
  /**
   * Attach a Google Cloud ID token to the WebSocket upgrade (Authorization
   * header). Required when the STT service is a Cloud Run service deployed
   * with --no-allow-unauthenticated. A fresh token is fetched per connection
   * attempt so long meetings never run past token expiry.
   */
  useIdToken?: boolean;
}

// Protocol (WhisperLive-compatible):
//   client -> server: binary PCM16 mono frames
//   server -> client: { "message": "partial", "transcript": "..." }
//                     { "message": "final",   "transcript": "..." }
//   Server closes the socket at end of stream.
export class SelfHostedSTTProvider implements STTProvider {
  onResult?: (result: SttResult) => void;
  onError?: (err: Error) => void;
  onEndOfStreamDone?: () => void;

  private ws: WebSocket | null = null;
  private maxRetries: number;
  private retryDelayMs: number;
  private closed = false;
  private draining = false;
  private retryAttempt = 0;

  constructor(private options: SelfHostedOptions) {
    // Defaults sized for a scale-to-zero GPU backend: a cold Cloud Run
    // instance may take 1-2 minutes (boot + model load) before the WebSocket
    // is accepted, so retries must outlast the cold start. Cumulative backoff
    // with these numbers covers roughly 4 minutes.
    this.maxRetries = options.maxRetries ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
  }

  connect(): Promise<void> {
    this.closed = false;
    return this.openSocket();
  }

  private openSocket(): Promise<void> {
    return this.buildAuthHeaders().then(
      (headers) => new Promise((resolve, reject) => {
        const ws = headers
          ? new WebSocket(this.options.url, { headers })
          : new WebSocket(this.options.url);
        this.ws = ws;

      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onOpenError);
        this.retryAttempt = 0;
        resolve();
      };

      const onOpenError = (event: ErrorEvent) => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onOpenError);
        const err = event.error instanceof Error ? event.error : new Error(event.message ?? 'ws connection failed');
        this.handleError(err);
        reject(err);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onOpenError);

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return; // we only send text to the STT
        try {
          const parsed = JSON.parse(event.data) as { message?: string; transcript?: string };
          if (parsed.message === 'partial' || parsed.message === 'final') {
            const text = (parsed.transcript ?? '').trim();
            if (!text) return;
            this.onResult?.({
              text,
              isFinal: parsed.message === 'final',
            });
          } else if (parsed.message === 'end_of_stream_done') {
            // Backend flushed its tail and is about to close; stop reconnecting.
            this.draining = true;
            this.onEndOfStreamDone?.();
          } else if (parsed.message === 'ready_to_stop' || parsed.message === 'info') {
            logger.debug({ message: parsed.message }, 'stt: control message');
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'stt: failed to parse result');
        }
      });

      ws.addEventListener('close', () => {
        if (this.closed) return;
        if (this.draining) {
          // Backend closed after end-of-stream ack (or mid-drain); either way
          // the drain is over — never reconnect once we are tearing down.
          this.onEndOfStreamDone?.();
          return;
        }
        logger.warn('stt: connection closed unexpectedly, scheduling reconnect');
        this.scheduleReconnect();
      });

      ws.addEventListener('error', (event) => {
        // 'error' is often followed by 'close'; the close handler schedules the reconnect.
        logger.debug('stt: websocket error event');
        void event;
      });
      }),
    );
  }

  /**
   * Build the Authorization header for the STT WebSocket upgrade.
   * Returns undefined when ID-token auth is disabled (local dev / dummy).
   *
   * Primary source: the Cloud Run/GCE metadata server, which mints an ID
   * token for the attached service account with zero configuration. Falls
   * back to google-auth-library for environments without the metadata
   * endpoint (e.g. Workload Identity on GKE).
   */
  private async buildAuthHeaders(): Promise<Record<string, string> | undefined> {
    if (!this.options.useIdToken) return undefined;
    // Cloud Run expects the audience to be the service's https origin.
    const audience = new URL(this.options.url.replace(/^ws(s?):/, 'http$1:')).origin;
    try {
      const resp = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
        { headers: { 'Metadata-Flavor': 'Google' } },
      );
      if (!resp.ok) throw new Error(`metadata responded ${resp.status}`);
      const token = (await resp.text()).trim();
      if (!token || token.split('.').length !== 3) throw new Error('malformed id token');
      logger.debug({ audience }, 'stt: fetched id token from metadata server');
      return { authorization: `Bearer ${token}` };
    } catch (metaErr) {
      const metaMsg = metaErr instanceof Error ? metaErr.message : String(metaErr);
      logger.warn({ err: metaMsg }, 'stt: metadata id-token fetch failed, trying google-auth-library');
    }
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth();
      const client = await auth.getIdTokenClient(audience);
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('no id token returned');
      logger.debug({ audience }, 'stt: fetched id token via google-auth-library');
      return { authorization: `Bearer ${token}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'stt: failed to fetch id token entirely, connecting WITHOUT auth - expect 401s if STT requires IAM');
      return undefined;
    }
  }

  sendAudio(pcm16: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('stt: dropping audio chunk, connection not open');
      return;
    }
    this.ws.send(pcm16);
  }

  sendEndOfStream(): void {
    if (this.closed || this.draining) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Nothing to flush against; surface completion so the caller never waits.
      this.onEndOfStreamDone?.();
      return;
    }
    this.draining = true;
    this.ws.send(JSON.stringify({ message: 'end_of_stream' }));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryAttempt >= this.maxRetries) {
      if (!this.closed) {
        this.handleError(new Error('stt: max reconnect attempts exceeded'));
      }
      return;
    }
    this.retryAttempt++;
    const delay = this.retryDelayMs * 2 ** (this.retryAttempt - 1);
    logger.info({ attempt: this.retryAttempt, delayMs: delay }, 'stt: reconnecting');
    setTimeout(() => {
      this.openSocket().catch(() => {
        // onError already fired for the failed open
      });
    }, delay);
  }

  private handleError(err: Error): void {
    this.onError?.(err);
  }

  close(): Promise<void> {
    this.closed = true;
    return new Promise((resolve) => {
      if (!this.ws) {
        resolve();
        return;
      }
      const ws = this.ws;
      ws.addEventListener('close', () => resolve());
      try {
        ws.close(1000, 'session ended');
      } catch {
        resolve();
      }
      // Safety timeout: never hang a session teardown on the backend socket.
      setTimeout(resolve, 2000).unref();
    });
  }
}