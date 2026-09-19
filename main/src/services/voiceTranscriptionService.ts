import { supabase } from '../Supabase/client';

// ─── Constants ──────────────────────────────────────────────────────────────
const PRESIGNED_URL_API = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-presignedURLs-audio';
const TRANSCRIBE_API = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/transcribe-audio';
const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes safety timeout
const SUPABASE_TABLE = 'speech_transcriptions';

export type TranscriptionSource = 'step2' | 'general_opinion' | 'question' | 'answer' | 'reply' | 'feedback';

// ─── UUID v4 Generator ──────────────────────────────────────────────────────
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Types ──────────────────────────────────────────────────────────────────
interface PresignedUrlResponse {
  success: boolean;
  bucket: string;
  object_key: string;
  presigned_url: string;
  expires_in: number;
}

export interface TranscriptionResult {
  text: string;
  recording_id: string;
}

export interface VoiceTranscriptionCallbacks {
  onUploadStart?: () => void;
  onUploadComplete?: () => void;
  onTranscriptionStart?: () => void;
  onPollingStart?: () => void;
  onTranscriptionComplete?: (text: string) => void;
  onError?: (error: string) => void;
}

// ─── Supabase: Insert initial row ───────────────────────────────────────────
async function insertTranscriptionRow(
  recordingId: string,
  userId: string,
  source: TranscriptionSource,
): Promise<void> {
  console.log(`[VoiceService] Stage 1: Inserting initial row into '${SUPABASE_TABLE}'...`, {
    recording_id: recordingId,
    user_id: userId,
    source,
    status: 'pending',
  });

  const { error } = await supabase
    .from(SUPABASE_TABLE)
    .insert({
      recording_id: recordingId,
      user_id: userId,
      source: source,
      status: 'pending',
      transcript: null,
      mime_type: 'audio/webm',
      language: 'en',
    });

  if (error) {
    console.error('[VoiceService] Stage 1 FAILED: Could not insert transcription row:', error.message);
    throw new Error(`Failed to create transcription record: ${error.message}`);
  }

  console.log('[VoiceService] Stage 1 SUCCESS: Row inserted into speech_transcriptions.');
}

// ─── API: Get Presigned Upload URL ──────────────────────────────────────────
async function getPresignedUrl(recordingId: string, userId: string): Promise<PresignedUrlResponse> {
  console.log('[VoiceService] Stage 2: Requesting presigned upload URL from AWS...');

  const response = await fetch(PRESIGNED_URL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording_id: recordingId,
      user_id: userId,
    }),
  });

  if (!response.ok) {
    console.error(`[VoiceService] Stage 2 FAILED: HTTP ${response.status}`);
    throw new Error(`Failed to get upload URL (${response.status})`);
  }

  const data = await response.json();
  if (!data.success || !data.presigned_url) {
    console.error('[VoiceService] Stage 2 FAILED: Invalid response payload:', data);
    throw new Error('Invalid presigned URL response from backend');
  }

  console.log('[VoiceService] Stage 2 SUCCESS: Presigned URL obtained.');
  return data as PresignedUrlResponse;
}

// ─── API: Upload Audio Binary (WebM) ────────────────────────────────────────
async function uploadAudio(presignedUrl: string, audioBlob: Blob): Promise<void> {
  console.log(`[VoiceService] Stage 3: Uploading original.webm (${audioBlob.size} bytes) to S3...`);

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: audioBlob,
    headers: {
      'Content-Type': 'audio/webm',
    },
  });

  if (!response.ok) {
    console.error(`[VoiceService] Stage 3 FAILED: S3 upload HTTP ${response.status}`);
    throw new Error(`Audio upload failed (${response.status})`);
  }

  console.log('[VoiceService] Stage 3 SUCCESS: Audio upload to S3 complete.');
}

// ─── API: Start Transcription ───────────────────────────────────────────────
async function startTranscription(recordingId: string, userId: string): Promise<void> {
  console.log('[VoiceService] Stage 4: Triggering backend transcription API...');

  const response = await fetch(TRANSCRIBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording_id: recordingId,
      user_id: userId,
    }),
  });

  if (!response.ok) {
    console.error(`[VoiceService] Stage 4 FAILED: Transcription API HTTP ${response.status}`);
    throw new Error(`Transcription request failed (${response.status})`);
  }

  console.log('[VoiceService] Stage 4 SUCCESS: Backend transcription pipeline started.');
}

// ─── Polling: Watch Supabase for transcription result ───────────────────────
function pollTranscription(
  recordingId: string,
  userId: string,
  abortSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let attempt = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    const onAbort = () => {
      cleanup();
      console.log('[VoiceService] Polling cancelled by AbortSignal.');
      reject(new Error('Cancelled'));
    };

    if (abortSignal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    abortSignal.addEventListener('abort', onAbort, { once: true });

    const poll = async () => {
      if (abortSignal.aborted) return;

      attempt++;
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);

      // Safety timeout: 10 minutes
      if (Date.now() - startTime > POLL_TIMEOUT_MS) {
        cleanup();
        abortSignal.removeEventListener('abort', onAbort);
        console.error(`[VoiceService] Stage 5 TIMEOUT: Polling timed out after ${elapsedSec}s (${attempt} attempts).`);
        reject(new Error('Transcription timed out after 10 minutes. Please try again.'));
        return;
      }

      try {
        const { data, error } = await supabase
          .from(SUPABASE_TABLE)
          .select('*')
          .eq('recording_id', recordingId)
          .eq('user_id', userId)
          .maybeSingle();

        if (error) {
          console.warn(`[VoiceService] Poll #${attempt} (${elapsedSec}s) - Supabase query error:`, error.message);
        } else if (data) {
          const status = data.status || 'unknown';
          const transcriptText =
            data.transcript ??
            data.transcription_text ??
            data.transcript_text ??
            data.transcribed_text ??
            '';
          const hasTranscript = Boolean(transcriptText && transcriptText.trim().length > 0);

          console.log(
            `Poll #${attempt}\n` +
            `Elapsed: ${elapsedSec} sec\n` +
            `Status: ${status}\n` +
            `Updated At: ${data.updated_at || 'N/A'}\n` +
            `Transcript: ${hasTranscript} (${hasTranscript ? transcriptText.length + ' chars' : 'empty'})`
          );

          if (status === 'completed') {
            // Check if transcript is non-empty
            if (hasTranscript) {
              cleanup();
              abortSignal.removeEventListener('abort', onAbort);
              console.log(
                `[VoiceService] Stage 5 SUCCESS: Polling finished on Poll #${attempt} after ${elapsedSec}s!\n` +
                `Transcript length: ${transcriptText.length} characters`
              );
              resolve(transcriptText as string);
              return;
            } else {
              console.warn(
                `[VoiceService] Poll #${attempt} (${elapsedSec}s): Status is 'completed' but transcript is empty/null in DB row. Continuing poll...`
              );
            }
          } else if (status === 'failed') {
            cleanup();
            abortSignal.removeEventListener('abort', onAbort);
            const errorMsg = data.error_message || 'Transcription processing failed on server.';
            console.error(`[VoiceService] Stage 5 FAILED on Poll #${attempt} (${elapsedSec}s): ${errorMsg}`);
            reject(new Error(errorMsg));
            return;
          }
        } else {
          console.log(`Poll #${attempt} | Elapsed: ${elapsedSec} sec | Row pending initial fetch...`);
        }
      } catch (err) {
        console.warn(`[VoiceService] Poll #${attempt} (${elapsedSec}s) - Fetch error:`, err);
      }

      if (!abortSignal.aborted) {
        timerId = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Start first poll after POLL_INTERVAL_MS
    timerId = setTimeout(poll, POLL_INTERVAL_MS);
  });
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────
export async function runTranscriptionPipeline(
  audioBlob: Blob,
  userId: string,
  source: TranscriptionSource,
  abortSignal: AbortSignal,
  callbacks?: VoiceTranscriptionCallbacks,
): Promise<TranscriptionResult> {
  const recordingId = generateUUID();
  console.log(`[VoiceService] Starting Voice Pipeline. Recording ID: ${recordingId}, User ID: ${userId}, Source: ${source}`);

  try {
    // Step 1: Insert record into speech_transcriptions BEFORE requesting presigned URL
    callbacks?.onUploadStart?.();
    if (abortSignal.aborted) throw new Error('Cancelled');
    await insertTranscriptionRow(recordingId, userId, source);

    // Step 2: Get presigned URL
    if (abortSignal.aborted) throw new Error('Cancelled');
    const presigned = await getPresignedUrl(recordingId, userId);

    // Step 3: Upload original WebM audio
    if (abortSignal.aborted) throw new Error('Cancelled');
    await uploadAudio(presigned.presigned_url, audioBlob);
    callbacks?.onUploadComplete?.();

    // Step 4: Start transcription
    if (abortSignal.aborted) throw new Error('Cancelled');
    callbacks?.onTranscriptionStart?.();
    await startTranscription(recordingId, userId);

    // Step 5: Poll for result until status == "completed" or "failed"
    console.log('[VoiceService] Stage 5: Starting polling loop...');
    callbacks?.onPollingStart?.();
    const text = await pollTranscription(recordingId, userId, abortSignal);

    callbacks?.onTranscriptionComplete?.(text);
    console.log(`[VoiceService] Pipeline COMPLETE. Returned transcript text length: ${text.length}`);
    return { text, recording_id: recordingId };
  } catch (err: any) {
    const message = err?.message || 'Transcription failed. Please try again.';
    console.error('[VoiceService] Pipeline ERROR:', err);
    callbacks?.onError?.(message);
    throw err;
  }
}
