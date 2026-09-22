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

  return {
    host: opt('HOST', '0.0.0.0'),
    port: Number.parseInt(opt('PORT', '8080'), 10),
    logLevel: opt('LOG_LEVEL', 'info'),
    supabaseUrl,
    supabaseServiceRoleKey,
    gcsBucket: required('GCS_BUCKET'),
    gcpProjectId: opt('GCP_PROJECT_ID', ''),
    pubsubPushToken: opt('PUBSUB_PUSH_TOKEN', ''),
    llmProvider: opt('LLM_PROVIDER', 'none'),
    llmBaseUrl: opt(
      'LLM_BASE_URL',
      'https://generativelanguage.googleapis.com/v1beta/openai',
    ),
    llmApiKey: opt('LLM_API_KEY', ''),
    // Cheap default: Gemini Flash-Lite via the OpenAI-compatible endpoint.
    llmModel: opt('LLM_MODEL', 'gemini-2.5-flash-lite'),
    jitsiActivatorUrl: opt('JITSI_ACTIVATOR_URL', ''),
  };
}