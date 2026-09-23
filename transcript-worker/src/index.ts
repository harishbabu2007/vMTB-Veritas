import 'dotenv/config';
import { loadConfig } from './config.js';
import logger from './logger.js';
import { createServer } from './server.js';
import { SupabaseStore } from './supabase.js';
import { StorageGcsClient } from './gcs.js';
import { processMeeting, type WorkerDeps } from './worker.js';

const config = loadConfig();
logger.level = config.logLevel;

const supabase = new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey);
const gcs = new StorageGcsClient(config.gcsBucket, config.gcpProjectId);

const deps: WorkerDeps = {
  supabase,
  gcs,
  llm: {
    provider: config.llmProvider,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
  },
  vm: { activatorUrl: config.jitsiActivatorUrl },
  stopMaxWaitMs: config.vmStopMaxWaitMs,
  stopPollIntervalMs: config.vmStopPollIntervalMs,
};

const server = createServer(config, {
  process: (meetingId) => processMeeting(meetingId, deps),
});

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, bucket: config.gcsBucket, llm: config.llmProvider },
    'transcript-worker started',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));