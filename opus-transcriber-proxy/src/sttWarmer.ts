import logger from './logger.js';

/**
 * Keeps the scale-to-zero STT Cloud Run service warm for the lifetime of a
 * transcription session. Activation-backend probes only cover meeting *startup*
 * polls; by the time someone says "transcription on" the GPU instance has often
 * already been reaped. An authenticated GET /ready every few minutes while the
 * JVB socket is open prevents that cold start (without ever writing
 * min-instances — see jitsi-activation-backend cost notes).
 */
export interface SttWarmerOptions {
  /** Absolute HTTP(S) URL of the STT /ready endpoint. */
  readyUrl: string;
  /** Attach a Google ID token when the service is --no-allow-unauthenticated. */
  useIdToken: boolean;
  /** Ping interval; must be well under Cloud Run's idle reap window. */
  intervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class SttWarmer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SttWarmerOptions) {
    this.intervalMs = options.intervalMs ?? 120_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Immediate ping: the session is opening now, don't wait a full interval.
    void this.ping();
    this.timer = setInterval(() => void this.ping(), this.intervalMs);
    this.timer.unref?.();
    logger.debug({ readyUrl: this.options.readyUrl, intervalMs: this.intervalMs }, 'stt: warmer started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.debug('stt: warmer stopped');
  }

  private async ping(): Promise<void> {
    if (!this.running) return;
    try {
      const headers: Record<string, string> = {};
      if (this.options.useIdToken) {
        const token = await this.fetchIdToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const resp = await this.fetchImpl(this.options.readyUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      logger.debug({ status: resp.status }, 'stt: warm ping');
    } catch (err) {
      // Never throw: warmth is best-effort; participant connects still retry.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'stt: warm ping failed');
    }
  }

  private async fetchIdToken(): Promise<string | null> {
    const audience = new URL(this.options.readyUrl).origin;
    try {
      const resp = await this.fetchImpl(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
      );
      if (!resp.ok) return null;
      const token = (await resp.text()).trim();
      return token || null;
    } catch {
      try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth();
        const client = await auth.getIdTokenClient(audience);
        const { token } = await client.getAccessToken();
        return token ?? null;
      } catch {
        return null;
      }
    }
  }
}

/** Derive the STT service base HTTP origin from a ws(s) WebSocket URL. */
export function httpOriginFromWsUrl(wsUrl: string): string | null {
  try {
    return new URL(wsUrl.replace(/^ws(s?):/, 'http$1:')).origin;
  } catch {
    return null;
  }
}
