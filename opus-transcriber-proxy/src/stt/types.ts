// STT backend abstraction. The proxy's JVB-facing layer only talks to this
// interface, so new backends (OpenAI, Deepgram, OpenAI-compatible endpoints)
// can be added without touching the JVB WebSocket layer.

export interface SttResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface STTProvider {
  /** Open the backend connection. Must resolve before sendAudio is called. */
  connect(): Promise<void>;
  /** Feed a chunk of mono PCM16 audio at the configured sample rate. */
  sendAudio(pcm16: Uint8Array): void;
  /**
   * Tell the backend no more audio is coming so it can flush its trailing
   * buffer as a final result. After this, the backend should emit any pending
   * final and then call `onEndOfStreamDone`.
   */
  sendEndOfStream(): void;
  /** Emitted for interim and final transcription results. */
  onResult?: (result: SttResult) => void;
  /** Emitted on unrecoverable backend errors. */
  onError?: (err: Error) => void;
  /**
   * Emitted every time the backend socket opens — both the initial connect
   * and each successful background reconnect. Lets the proxy resume feeding
   * audio after a cold-start / 429 recovery (the connect() promise only
   * settles for the first attempt).
   */
  onOpen?: () => void;
  /**
   * Emitted when the backend has acknowledged end-of-stream (or the
   * connection dropped during the drain). Lets the proxy stop waiting.
   */
  onEndOfStreamDone?: () => void;
  /** Close the backend connection. */
  close(): Promise<void>;
}

/**
 * Internal normalized transcript event (the format used by the persistence
 * layer). `startTime`/`endTime` are seconds relative to the proxy session
 * start. Participant identity is preserved from the JVB media `tag`.
 */
export interface TranscriptEvent {
  meetingId: string;
  participantId: string;
  startTime: number;
  endTime: number;
  text: string;
  isFinal: boolean;
  provider: string;
}