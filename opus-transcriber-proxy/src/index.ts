import 'dotenv/config';
import { loadConfig } from './config.js';
import logger from './logger.js';
import { createServer } from './server.js';
import { SupabaseStore } from './store/supabase.js';
import { PubSubPublisher } from './store/pubsub.js';
import type { TranscriptEvent } from './stt/types.js';

const config = loadConfig();

logger.level = config.logLevel;

// Persistence + event publishing. Both are isolated from the real-time path:
// a failure here is logged, never thrown, so transcription never breaks a meeting.
const store =
  config.persistence === 'supabase'
    ? new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey)
    : null;

const publisher = new PubSubPublisher(config.gcpProjectId, config.pubsubTopic);

if (config.pubsubEmulatorHost) {
  process.env.PUBSUB_EMULATOR_HOST = config.pubsubEmulatorHost;
  logger.info({ host: config.pubsubEmulatorHost }, 'pubsub: using emulator');
}

if (!store) {
  logger.warn('persistence: disabled (PERSISTENCE=none), segments will not be stored');
}

// In-flight segment inserts. meeting.completed must not be published until
// these settle, otherwise transcript-worker can read a truncated segment list.
const pendingInserts = new Set<Promise<void>>();

/** Bounded wait so a hung insert can never stall session teardown forever. */
const INSERT_DRAIN_TIMEOUT_MS = 5_000;

function trackInsert(promise: Promise<void>): void {
  pendingInserts.add(promise);
  void promise.finally(() => pendingInserts.delete(promise));
}

async function drainPendingInserts(): Promise<void> {
  if (pendingInserts.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, INSERT_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled([...pendingInserts]), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const { server, stats, close } = createServer(config, {
  // Only final segments are persisted; the store ignores interim events.
  onTranscription: (event: TranscriptEvent) => {
    if (store && event.isFinal) {
      trackInsert(store.insertFinalSegment(event));
    }
  },
  onSessionClosed: async (sessionId) => {
    try {
      if (store) await store.ensureMeeting(sessionId);
    } catch (err) {
      logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'session: ensureMeeting before publish failed',
      );
    }
    await drainPendingInserts();
    // Always publish: a missing transcript row is better than a stuck PENDING
    // that never generates an artifact. The worker re-reads after a settle wait.
    await publisher.publishMeetingCompleted(sessionId, null);
  },
});

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, provider: config.provider, persistence: config.persistence },
    'opus-transcriber-proxy started',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await drainPendingInserts();
  await close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { stats };