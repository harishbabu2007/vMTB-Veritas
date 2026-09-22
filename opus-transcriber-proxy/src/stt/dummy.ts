import type { STTProvider, SttResult } from './types.js';

/**
 * Dummy STT provider for local development and tests. Emits a "partial" and a
 * "final" result once it has received at least `finalAfterSamples` PCM samples
 * (default 1.6 s at 16 kHz), then resets and waits for the next utterance.
 * Lets the whole pipeline (JVB ws -> opus decode -> normalization -> Supabase)
 * be exercised without a GPU/STT service.
 */
export class DummySTTProvider implements STTProvider {
  onResult?: (result: SttResult) => void;
  onError?: (err: Error) => void;
  onEndOfStreamDone?: () => void;

  private receivedSamples = 0;
  private finalAfterSamples: number;
  private counter = 0;
  private connected = false;

  constructor(finalAfterSamples = 16000 * 1.6) {
    this.finalAfterSamples = finalAfterSamples;
  }

  connect(): Promise<void> {
    this.connected = true;
    this.receivedSamples = 0;
    return Promise.resolve();
  }

  sendAudio(pcm16: Uint8Array): void {
    if (!this.connected) return;
    this.receivedSamples += Math.floor(pcm16.byteLength / 2);
    if (this.receivedSamples >= this.finalAfterSamples) {
      const interim: SttResult = {
        text: `dummy interim ${this.counter}`,
        isFinal: false,
      };
      this.onResult?.(interim);
      const final: SttResult = {
        text: `dummy final segment ${this.counter}`,
        isFinal: true,
      };
      this.onResult?.(final);
      this.counter++;
      this.receivedSamples = 0;
    }
  }

  sendEndOfStream(): void {
    if (!this.connected) {
      this.onEndOfStreamDone?.();
      return;
    }
    if (this.receivedSamples > 0) {
      this.onResult?.({
        text: `dummy final segment ${this.counter}`,
        isFinal: true,
      });
      this.counter++;
      this.receivedSamples = 0;
    }
    this.onEndOfStreamDone?.();
  }

  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}