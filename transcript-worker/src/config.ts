// Environment-driven configuration. No config files, no secrets in code.

export interface Config {
  host: string;
  port: number;
  logLevel: string;

  // Supabase (transactional status + segment reads)
  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  // GCS artifacts
  gcsBucket: string;
  gcpProjectId: string;

  // Pub/Sub push verification. Empty token disables auth (dev only).
  pubsubPushToken: string;

  // LLM minutes-of-meeting (optional; no-op when unset)
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;

  // Automatic VM teardown: after processing a completed meeting the worker
  // POSTs {url}/stop-jitsi (only when no other session is live). Empty = off.
  jitsiActivatorUrl: string;
  /**
   * How long stopVmIfQuiet may wait/retry within a single push delivery
   * (live-session grace recheck + /stop-jitsi call retries). Must leave headroom
   * under the Cloud Run request timeout (600s).
   */
  vmStopMaxWaitMs: number;
  /** Delay between live-session rechecks / stop call retries. */
  vmStopPollIntervalMs: number;
}

export function loadConfig(): Config {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing required environment variable ${key}. See .env.example / README.md.`);
    return v;
  };
  const opt = (key: string, fallback: string): string => process.env[key] ?? fallback;

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  const llmProvider = opt('LLM_PROVIDER', 'none');
  const gcpProjectId = opt('GCP_PROJECT_ID', '');
  const vertexLocation = opt('VERTEX_LOCATION', 'global');
  // Vertex OpenAI-compatible Chat Completions endpoint. Global endpoint has
  // the same list price as regional (regional adds ~10% since 2026-07).
  const vertexBaseUrl = gcpProjectId
    ? `https://aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${vertexLocation}/endpoints/openapi`
    : '';
  const defaultBaseUrl =
    llmProvider === 'vertex'
      ? vertexBaseUrl
      : 'https://generativelanguage.googleapis.com/v1beta/openai';
  // Vertex requires a google/ model-id prefix on the OpenAI-compatible API.
  const defaultModel =
    llmProvider === 'vertex' ? 'google/gemini-3.1-flash-lite' : 'gemini-3.1-flash-lite';

  return {
    host: opt('HOST', '0.0.0.0'),
    port: Number.parseInt(opt('PORT', '8080'), 10),
    logLevel: opt('LOG_LEVEL', 'info'),
    supabaseUrl,
    supabaseServiceRoleKey,
    gcsBucket: required('GCS_BUCKET'),
    gcpProjectId,
    pubsubPushToken: opt('PUBSUB_PUSH_TOKEN', ''),
    llmProvider,
    llmBaseUrl: opt('LLM_BASE_URL', defaultBaseUrl),
    llmApiKey: opt('LLM_API_KEY', ''),
    // Cheap default: Gemini 3.1 Flash-Lite (2.5-flash-lite is ~2.4× cheaper
    // but Google retires it 2026-10-16 — see docs/DEPLOYMENT.md §5).
    llmModel: opt('LLM_MODEL', defaultModel),
    jitsiActivatorUrl: opt('JITSI_ACTIVATOR_URL', ''),
    // 4 minutes covers the 3-minute analytics heartbeat grace plus stop retries,
    // while fitting inside the 600s Cloud Run timeout with processing headroom.
    vmStopMaxWaitMs: Number.parseInt(opt('VM_STOP_MAX_WAIT_MS', '240000'), 10),
    vmStopPollIntervalMs: Number.parseInt(opt('VM_STOP_POLL_INTERVAL_MS', '15000'), 10),
  };
}