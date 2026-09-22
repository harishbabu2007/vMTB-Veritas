import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import logger from './logger.js';
import { OpusToPcm16 } from './opusDecoder.js';
import {
  buildPong,
  buildServerInfo,
  buildTranscriptionResult,
  parseInboundMessage,
  type ParsedInbound,
} from './protocol.js';
import type { STTProvider, TranscriptEvent } from './stt/types.js';

export interface TranscriberProxyOptions {
  sessionId: string;
  provider: string;
  sampleRate: number;
  chunkMs: number;
  /** Factory used to create the per-participant STT connection. */
  sttFactory: (tag: string) => STTProvider;
  /**
   * Max time (ms) to wait for the STT end-of-stream handshake on close so the
   * trailing audio of the meeting can be committed as a final segment.
   */
  sttDrainTimeoutMs?: number;
}

/**
 * One JVB transcription session (one WebSocket connection). Multiple
 * participants (media tags) share the session; each participant gets its own
 * Opus decoder + STT connection. Final results are normalized into
 * TranscriptEvents and emitted on 'transcription'.
 */
export class TranscriberProxy extends EventEmitter {
  readonly sessionId: string;
  readonly provider: string;

  private readonly options: TranscriberProxyOptions;
  private ws: WebSocket;
  private readonly connections = new Map<string, OutgoingConnection>();
  private readonly sessionStartSec: number;
  private readonly sttFactory: (tag: string) => STTProvider;
  private finalCount = 0;
  private closed = false;

  constructor(ws: WebSocket, options: TranscriberProxyOptions) {
    super();
    this.ws = ws;
    this.options = options;
    this.sessionId = options.sessionId;
    this.provider = options.provider;
    this.sessionStartSec = nowSec();
    this.sttFactory = options.sttFactory;

    this.setupWebSocketListeners();
  }

  get activeParticipants(): number {
    return this.connections.size;
  }

  get finalsSent(): number {
    return this.finalCount;
  }

  private setupWebSocketListeners(): void {
    this.ws.addEventListener('close', () => {
      // Async drain: flush trailing audio + wait for the STT final before
      // emitting 'closed' (so segment inserts land before meeting.completed).
      void this.close();
    });

    this.ws.addEventListener('message', (event) => {
      let parsed: ParsedInbound;
      try {
        parsed = parseInboundMessage(JSON.parse(event.data as string));
      } catch (err) {
        logger.warn(
          { sessionId: this.sessionId, err: err instanceof Error ? err.message : String(err) },
          'ws: dropping invalid message',
        );
        return;
      }

      switch (parsed.kind) {
        case 'ping':
          this.ws.send(JSON.stringify(buildPong(parsed.id)));
          break;
        case 'start':
          this.handleStart(parsed.tag!);
          break;
        case 'media':
          if (parsed.media) this.handleMedia(parsed.media);
          break;
        case 'info':
          logger.info({ sessionId: this.sessionId }, 'ws: info message from JVB');
          break;
        case 'unknown':
        default:
          logger.debug({ sessionId: this.sessionId }, 'ws: unknown event ignored');
      }
    });

    // Announce ourselves to JVB (session/provider details for observability).
    try {
      this.ws.send(JSON.stringify(buildServerInfo(this.sessionId, this.provider)));
    } catch (err) {
      logger.debug({ err }, 'ws: could not send server info');
    }
  }

  private handleStart(tag: string): void {
    if (!this.connections.has(tag)) {
      this.createConnection(tag);
    }
  }

  private handleMedia(media: { tag: string; chunk: number; timestamp: number; payload: Buffer }): void {
    let connection = this.connections.get(media.tag);
    if (!connection) {
      // Tolerate media arriving before any start event (upstream does the same).
      connection = this.createConnection(media.tag);
    }
    connection.handleMedia(media);
  }

  private createConnection(tag: string): OutgoingConnection {
    const stt = this.sttFactory(tag);

    const connection = new OutgoingConnection({
      tag,
      sessionId: this.sessionId,
      provider: this.provider,
      sessionStartSec: this.sessionStartSec,
      sampleRate: this.options.sampleRate,
      chunkMs: this.options.chunkMs,
      drainTimeoutMs: this.options.sttDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      stt,
      onEvent: (event) => this.handleTranscriptEvent(event),
      onError: (err) => {
        logger.error({ sessionId: this.sessionId, tag, err: err.message }, 'conn: STT error');
      },
      onClosed: (closedTag) => {
        this.connections.delete(closedTag);
      },
    });

    this.connections.set(tag, connection);
    connection.start().catch((err) => {
      logger.error({ sessionId: this.sessionId, tag, err: err instanceof Error ? err.message : String(err) }, 'conn: failed to start');
    });

    return connection;
  }

  private handleTranscriptEvent(event: TranscriptEvent): void {
    if (event.isFinal) {
      this.finalCount++;
    }
    this.emit('transcription', event);

    // Echo final results back to JVB (sendBack), so Jitsi can render
    // captions if the client has them enabled. Best-effort.
    if (this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(
          JSON.stringify(
            buildTranscriptionResult({
              participantId: event.participantId,
              text: event.text,
              isFinal: event.isFinal,
              timestamp: Date.now(),
            }),
          ),
        );
      } catch {
        // ignore
      }
    }
  }

  /**
   * Drain all participant connections (flush leftover audio, wait for the STT
   * end-of-stream final), then emit 'closed' exactly once. Awaited by the
   * WS close handler so meeting.completed is only published after the tail
   * of the meeting has been persisted.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    logger.info(
      {
        sessionId: this.sessionId,
        durationSec: (nowSec() - this.sessionStartSec).toFixed(1),
        activeParticipants: this.connections.size,
        finals: this.finalCount,
      },
      'session: closing',
    );
    const connections = [...this.connections.values()];
    this.connections.clear();
    // Drain concurrently across participants; each has its own STT socket.
    await Promise.allSettled(connections.map((connection) => connection.drainAndClose()));
    this.emit('closed');
  }
}

/** Default wait for the STT flush handshake when the meeting ends. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

interface OutgoingConnectionOptions {
  tag: string;
  sessionId: string;
  provider: string;
  sessionStartSec: number;
  sampleRate: number;
  chunkMs: number;
  drainTimeoutMs: number;
  stt: STTProvider;
  onEvent: (event: TranscriptEvent) => void;
  onError: (err: Error) => void;
  onClosed: (tag: string) => void;
}

class OutgoingConnection {
  private readonly options: OutgoingConnectionOptions;
  private readonly decoder: OpusToPcm16;
  private pcmAccumulator: Int16Array = new Int16Array(0);
  private utteranceStartSec: number;
  private started = false;
  private pendingMedia: Buffer[] = [];
  /** In-flight decodeAndBuffer() promises, awaited before drain. */
  private readonly inFlightDecodes = new Set<Promise<void>>();
  private draining = false;
  private closed = false;

  constructor(options: OutgoingConnectionOptions) {
    this.options = options;
    this.decoder = new OpusToPcm16();
    this.utteranceStartSec = options.sessionStartSec;

    options.stt.onResult = (result) => this.handleSttResult(result);
    options.stt.onError = (err) => options.onError(err);
  }

  async start(): Promise<void> {
    await this.decoder.ready;
    await this.options.stt.connect();
    this.started = true;
    this.utteranceStartSec = nowSec();
    logger.debug({ sessionId: this.options.sessionId, tag: this.options.tag }, 'conn: started');

    // Flush frames that arrived before the backend was ready. Bounded by the
    // queue cap in handleMedia, so it cannot grow unbounded.
    const queued = this.pendingMedia.splice(0);
    for (const payload of queued) {
      this.trackDecode(this.decodeAndBuffer(payload));
    }
  }

  handleMedia(media: { payload: Buffer }): void {
    if (this.draining || this.closed) return;
    if (!this.started) {
      // The JVB can send media before our backend is ready; buffer instead of
      // dropping. Cap at ~10s of audio so a stuck backend can't grow memory.
      if (this.pendingMedia.length < 500) {
        this.pendingMedia.push(media.payload);
      } else {
        logger.warn({ sessionId: this.options.sessionId, tag: this.options.tag }, 'conn: media queue full, dropping');
      }
      return;
    }
    this.trackDecode(this.decodeAndBuffer(media.payload));
  }

  private trackDecode(promise: Promise<void>): void {
    this.inFlightDecodes.add(promise);
    void promise.finally(() => this.inFlightDecodes.delete(promise));
  }

  private async decodeAndBuffer(payload: Buffer): Promise<void> {
    const pcm16 = await this.decoder.decode(payload, this.options.sampleRate);
    if (pcm16.length === 0) return;
    this.pcmAccumulator = concatInt16(this.pcmAccumulator, pcm16);

    const chunkSamples = Math.round((this.options.sampleRate * this.options.chunkMs) / 1000);
    if (this.pcmAccumulator.length >= chunkSamples) {
      this.flushChunk();
    }
  }

  private flushChunk(): void {
    const chunkSamples = Math.round((this.options.sampleRate * this.options.chunkMs) / 1000);
    let offset = 0;
    while (offset + chunkSamples <= this.pcmAccumulator.length) {
      const chunk = this.pcmAccumulator.subarray(offset, offset + chunkSamples);
      // Copy so the underlying buffer can be GC'd freely.
      const copy = new Int16Array(chunk);
      this.options.stt.sendAudio(new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength));
      offset += chunkSamples;
    }
    if (offset > 0) {
      this.pcmAccumulator = this.pcmAccumulator.subarray(offset);
    }
  }

  /** Send any sub-chunk remainder so no trailing audio is dropped on close. */
  private flushRemainder(): void {
    if (this.pcmAccumulator.length === 0) return;
    const copy = new Int16Array(this.pcmAccumulator);
    this.pcmAccumulator = new Int16Array(0);
    this.options.stt.sendAudio(new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength));
  }

  private handleSttResult(result: { text: string; isFinal: boolean }): void {
    const now = nowSec();
    if (result.isFinal) {
      const start = this.utteranceStartSec;
      this.utteranceStartSec = now;
      this.options.onEvent({
        meetingId: this.options.sessionId,
        participantId: this.options.tag,
        startTime: start,
        endTime: now,
        text: result.text,
        isFinal: true,
        provider: this.options.provider,
      });
    } else {
      // Interim results are NOT persisted. Emitted only so a future realtime
      // feed can use them; the persistence layer ignores them anyway.
      this.options.onEvent({
        meetingId: this.options.sessionId,
        participantId: this.options.tag,
        startTime: this.utteranceStartSec,
        endTime: now,
        text: result.text,
        isFinal: false,
        provider: this.options.provider,
      });
    }
  }

  /**
   * End-of-meeting drain:
   *   1. await in-flight Opus decodes (last frames may still be decoding)
   *   2. send the sub-chunk PCM remainder
   *   3. tell STT end-of-stream and wait (bounded) for its final flush
   *   4. tear down decoder + STT socket
   *
   * Never throws: a stuck backend must not hang session teardown forever.
   */
  async drainAndClose(): Promise<void> {
    if (this.closed) return;
    this.draining = true;

    try {
      await Promise.allSettled([...this.inFlightDecodes]);
      this.flushRemainder();

      const stt = this.options.stt;
      const done = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stt.onEndOfStreamDone = undefined;
          resolve();
        };
        const timer = setTimeout(finish, this.options.drainTimeoutMs);
        timer.unref?.();
        stt.onEndOfStreamDone = finish;
      });

      try {
        stt.sendEndOfStream();
      } catch (err) {
        logger.warn(
          {
            sessionId: this.options.sessionId,
            tag: this.options.tag,
            err: err instanceof Error ? err.message : String(err),
          },
          'conn: sendEndOfStream failed',
        );
      }
      await done;
    } catch (err) {
      logger.warn(
        {
          sessionId: this.options.sessionId,
          tag: this.options.tag,
          err: err instanceof Error ? err.message : String(err),
        },
        'conn: drain failed, closing anyway',
      );
    } finally {
      this.draining = false;
      this.closed = true;
      try {
        await this.decoder.close();
      } catch {
        // ignore
      }
      try {
        await this.options.stt.close();
      } catch {
        // ignore
      }
      this.options.onClosed(this.options.tag);
    }
  }

  /** Immediate teardown without the end-of-stream handshake (tests/legacy). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.decoder.close();
    void this.options.stt.close();
    this.options.onClosed(this.options.tag);
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function nowSec(): number {
  return Date.now() / 1000;
}