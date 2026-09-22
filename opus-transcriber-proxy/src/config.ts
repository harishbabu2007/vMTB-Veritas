// Environment configuration for the opus-transcriber-proxy.
// All configuration is done via environment variables (no config files).
// Never put secrets in code; use Secret Manager / env vars in production.

export interface Config {
  // Server
  host: string;
  port: number;
  logLevel: string;

  // STT backend selection
  provider: 'self-hosted' | 'dummy';
  sttWsUrl: string; // WhisperLive-compatible WebSocket URL for the self-hosted provider
  sttSampleRate: number; // PCM sample rate forwarded to the STT backend (Hz)
  sttChunkMs: number; // accumulate this many ms of PCM before forwarding to STT
  sttUseIdToken: boolean; // attach a Google ID token when connecting (Cloud Run IAM)
  sttDrainTimeoutMs: number; // max wait for the STT end-of-stream flush on session close

  // Supabase persistence
  persistence: 'supabase' | 'none';
  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  // Pub/Sub (meeting.completed events). Optional; publishing is a no-op when unset.
  gcpProjectId: string | null;
  pubsubTopic: string | null;
  pubsubEmulatorHost: string | null;

  // Session identity
  maxSessionIdLength: number;
}

function env(key: string): string | undefined {
  return process.env[key];
}

function required(key: string): string {
  const v = env(key);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${key}. See .env.example / README.md.`,
    );
  }
  return v;
}

function optionalInt(key: string, fallback: number): number {
  const v = env(key);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

export function loadConfig(): Config {
  const provider = (env('PROVIDER') ?? 'self-hosted') as Config['provider'];
  if (provider !== 'self-hosted' && provider !== 'dummy') {
    throw new Error(`Invalid PROVIDER "${provider}". Expected "self-hosted" or "dummy".`);
  }

  const persistence = (env('PERSISTENCE') ?? 'supabase') as Config['persistence'];
  if (persistence !== 'supabase' && persistence !== 'none') {
    throw new Error(`Invalid PERSISTENCE "${persistence}". Expected "supabase" or "none".`);
  }

  const config: Config = {
    host: env('HOST') ?? '0.0.0.0',
    port: optionalInt('PORT', 8080),
    logLevel: env('LOG_LEVEL') ?? 'info',
    provider,
    sttWsUrl: env('STT_WS_URL') ?? '',
    sttSampleRate: optionalInt('STT_SAMPLE_RATE', 16000),
    sttChunkMs: optionalInt('STT_CHUNK_MS', 60),
    sttUseIdToken: env('STT_USE_ID_TOKEN') === 'true',
    sttDrainTimeoutMs: optionalInt('STT_DRAIN_TIMEOUT_MS', 10_000),
    persistence,
    supabaseUrl: env('SUPABASE_URL') ?? '',
    supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    gcpProjectId: env('GCP_PROJECT_ID') ?? null,
    pubsubTopic: env('PUBSUB_TOPIC') ?? null,
    pubsubEmulatorHost: env('PUBSUB_EMULATOR_HOST') ?? null,
    maxSessionIdLength: optionalInt('MAX_SESSION_ID_LENGTH', 128),
  };

  if (provider === 'self-hosted' && !config.sttWsUrl) {
    throw new Error(
      'PROVIDER=self-hosted requires STT_WS_URL (the WebSocket URL of the self-hosted STT service).',
    );
  }
  if (persistence === 'supabase' && (!config.supabaseUrl || !config.supabaseServiceRoleKey)) {
    throw new Error(
      'PERSISTENCE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (final transcript segments are persisted to Supabase). Set PERSISTENCE=none for local runs without a database.',
    );
  }

  return config;
}