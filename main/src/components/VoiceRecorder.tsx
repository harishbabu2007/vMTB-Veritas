import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, X, ArrowUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { runTranscriptionPipeline, TranscriptionSource } from '../services/voiceTranscriptionService';
import { showToast } from '../utils/toast';
import './VoiceRecorder.css';

// ─── Types ──────────────────────────────────────────────────────────────────
type RecorderState = 'idle' | 'recording' | 'processing';

interface VoiceRecorderProps {
  /** Called when transcription completes with the final text. */
  onTranscriptionComplete: (text: string) => void;
  /** Visual variant */
  variant?: 'card' | 'inline' | 'explanation';
  /** Database source context ('step2' | 'general_opinion' | 'question' | 'answer') */
  source?: TranscriptionSource;
  /** Icon size for the idle mic (px). Defaults differ by variant. */
  iconSize?: number;
}

// ─── Waveform drawing ───────────────────────────────────────────────────────
const BAR_COUNT = 28;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_RADIUS = 1.5;
const BAR_COLOR = '#4A90E2';

function drawWaveform(
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode,
  dataArray: Uint8Array<ArrayBuffer>,
  animFrameRef: React.MutableRefObject<number | null>,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const draw = () => {
    analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, rect.width, rect.height);

    const totalBarWidth = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    const startX = (rect.width - totalBarWidth) / 2;
    const centerY = rect.height / 2;

    for (let i = 0; i < BAR_COUNT; i++) {
      const dataIndex = Math.floor((i / BAR_COUNT) * dataArray.length);
      const value = dataArray[dataIndex] / 255;
      const barHeight = Math.max(3, value * rect.height * 0.85);
      const x = startX + i * (BAR_WIDTH + BAR_GAP);
      const y = centerY - barHeight / 2;

      ctx.beginPath();
      const r = Math.min(BAR_RADIUS, BAR_WIDTH / 2, barHeight / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + BAR_WIDTH, y, x + BAR_WIDTH, y + barHeight, r);
      ctx.arcTo(x + BAR_WIDTH, y + barHeight, x, y + barHeight, r);
      ctx.arcTo(x, y + barHeight, x, y, r);
      ctx.arcTo(x, y, x + BAR_WIDTH, y, r);
      ctx.closePath();
      ctx.fillStyle = BAR_COLOR;
      ctx.globalAlpha = 0.5 + value * 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    animFrameRef.current = requestAnimationFrame(draw);
  };

  draw();
}

// ─── Timer formatter ────────────────────────────────────────────────────────
function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Component ──────────────────────────────────────────────────────────────
export function VoiceRecorder({
  onTranscriptionComplete,
  variant = 'card',
  source,
  iconSize,
}: VoiceRecorderProps) {
  const { user } = useAuth();
  const [state, setState] = useState<RecorderState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Derive source if not explicitly passed
  const effectiveSource: TranscriptionSource =
    source || (variant === 'explanation' ? 'step2' : variant === 'card' ? 'general_opinion' : 'answer');

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<RecorderState>('idle');

  // Keep stateRef synced with state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Handle visibility change logging (recording MUST continue in background)
  useEffect(() => {
    const handleVisibilityChange = () => {
      console.log(`[VoiceRecorder] Visibility state changed to: '${document.visibilityState}'. Current recorder state: '${stateRef.current}'`);
      // Auto-resume AudioContext if suspended when tab becomes visible or during recording
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch((err) => {
          console.warn('[VoiceRecorder] Could not resume AudioContext:', err);
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);

  // Cleanup on unmount ONLY if component is destroyed
  useEffect(() => {
    return () => {
      console.log('[VoiceRecorder] Component unmounted. Running cleanup.');
      stopRecordingCleanup();
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecordingCleanup = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (_) {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (_) {
        // ignore
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    dataArrayRef.current = null;
    chunksRef.current = [];
  }, []);

  // ─── Start Recording ────────────────────────────────────────────────────
  const handleStartRecording = useCallback(async () => {
    setErrorMsg(null);
    setElapsedSeconds(0);

    if (!user?.id) {
      showToast.error('Please log in to use voice input.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setErrorMsg('Voice recording is not supported on this browser.');
      showToast.error('Voice recording is not supported on this browser.');
      return;
    }

    console.log('[VoiceRecorder] Requesting microphone access...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Ensure tracks stay active during background tab switching
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          console.warn('[VoiceRecorder] Audio track ended unexpectedly.');
        };
      });

      // Setup AudioContext + Analyser for waveform
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;

      // Listen for AudioContext suspension (e.g. background tab) and auto-resume
      audioCtx.onstatechange = () => {
        console.log(`[VoiceRecorder] AudioContext state changed to: ${audioCtx.state}`);
        if (audioCtx.state === 'suspended' && stateRef.current === 'recording') {
          audioCtx.resume().catch((e) => console.warn('[VoiceRecorder] Failed to resume AudioContext:', e));
        }
      };

      const audioSource = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      audioSource.connect(analyser);
      analyserRef.current = analyser;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      dataArrayRef.current = dataArray;

      // Prefer WebM/Opus (what the backend already expects). Safari doesn't
      // support audio/webm at all, so both checks fail there and we fall back
      // to the browser's own default container (typically MP4/AAC on
      // Safari) — recorder.mimeType below reflects whatever was actually
      // picked, so the blob/upload downstream is labeled correctly either way.
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onerror = (event: any) => {
        console.error('[VoiceRecorder] MediaRecorder error:', event.error || event);
      };

      recorder.start(250); // collect data every 250ms
      setState('recording');
      console.log('[VoiceRecorder] Recording started successfully. MimeType:', mimeType || 'default');

      // Start recording timer
      timerIntervalRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);

      // Start waveform animation after a tick to let canvas mount
      requestAnimationFrame(() => {
        if (canvasRef.current && analyserRef.current && dataArrayRef.current) {
          drawWaveform(canvasRef.current, analyserRef.current, dataArrayRef.current, animFrameRef);
        }
      });
    } catch (err: any) {
      console.error('[VoiceRecorder] Microphone error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMsg('Microphone permission denied. Please allow access and try again.');
        showToast.error('Microphone permission denied.');
      } else if (err.name === 'NotFoundError') {
        setErrorMsg('No microphone found. Please connect a microphone.');
        showToast.error('No microphone detected.');
      } else {
        setErrorMsg('Could not start recording. Please try again.');
        showToast.error('Failed to start recording.');
      }
      stopRecordingCleanup();
    }
  }, [user?.id, stopRecordingCleanup]);

  // ─── Cancel Recording ───────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    console.log('[VoiceRecorder] User explicitly cancelled recording.');
    stopRecordingCleanup();
    setState('idle');
    setElapsedSeconds(0);
    setErrorMsg(null);
  }, [stopRecordingCleanup]);

  // ─── Send Recording ────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    if (!user?.id) return;

    console.log('[VoiceRecorder] User explicitly clicked Send. Stopping MediaRecorder...');
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      handleCancel();
      return;
    }

    // Gather final data before stopping
    recorder.onstop = async () => {
      // recorder.mimeType reflects the container the browser actually used
      // (e.g. audio/mp4 on Safari), not necessarily audio/webm — label the
      // blob with the real format instead of assuming WebM.
      const recordedMimeType = recorder.mimeType || 'audio/webm';
      console.log(`[VoiceRecorder] MediaRecorder onstop fired. Assembling audio blob as ${recordedMimeType}...`);
      const audioBlob = new Blob(chunksRef.current, { type: recordedMimeType });
      console.log(`[VoiceRecorder] Audio blob created. Size: ${audioBlob.size} bytes (${(audioBlob.size / 1024 / 1024).toFixed(2)} MB)`);

      // Stop timer, animation + stream but keep state as processing
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch (_) { /* */ }
        audioContextRef.current = null;
      }

      setState('processing');
      setElapsedSeconds(0);
      setErrorMsg(null);

      // Create abort controller for pipeline
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        console.log('[VoiceRecorder] Calling runTranscriptionPipeline...');
        const result = await runTranscriptionPipeline(
          audioBlob,
          user.id,
          effectiveSource,
          abortController.signal,
        );

        console.log(`[VoiceRecorder] Pipeline returned transcript length: ${result.text.length} characters.`);
        console.log('[VoiceRecorder] Calling onTranscriptionComplete callback...');
        onTranscriptionComplete(result.text);
        console.log('[VoiceRecorder] onTranscriptionComplete executed. Returning to idle state.');
        setState('idle');
      } catch (err: any) {
        if (err?.message === 'Cancelled') {
          console.log('[VoiceRecorder] Transcription pipeline was cancelled.');
          setState('idle');
          return;
        }
        console.error('[VoiceRecorder] Pipeline error:', err);
        const msg = err?.message?.includes('timed out')
          ? 'Transcription timed out. Please try again.'
          : err?.message || 'Transcription failed. Please try again.';
        setErrorMsg(msg);
        showToast.error(msg);
        setState('idle');
      } finally {
        abortControllerRef.current = null;
        chunksRef.current = [];
      }
    };

    try {
      recorder.stop();
    } catch (err) {
      console.error('[VoiceRecorder] Error stopping MediaRecorder:', err);
      handleCancel();
    }
  }, [user?.id, effectiveSource, onTranscriptionComplete, handleCancel]);

  // ─── Render ─────────────────────────────────────────────────────────────
  const wrapperClass = `voice-recorder voice-recorder--${variant}`;
  const micSize = iconSize ?? (variant === 'inline' ? 14 : variant === 'explanation' ? 18 : 16);

  // IDLE state: just show mic icon
  if (state === 'idle') {
    return (
      <div className={wrapperClass}>
        <button
          type="button"
          className="voice-recorder-mic-btn"
          onClick={handleStartRecording}
          title="Voice input"
          aria-label="Start voice recording"
        >
          <Mic style={{ width: micSize, height: micSize }} />
        </button>
        {errorMsg && <p className="voice-recorder-error">{errorMsg}</p>}
      </div>
    );
  }

  // PROCESSING state: show spinner + "Transcribing..."
  if (state === 'processing') {
    return (
      <div className={wrapperClass}>
        <div className="voice-recorder-loading">
          <div className="voice-recorder-spinner" />
          <span className="voice-recorder-loading-text">Transcribing...</span>
        </div>
      </div>
    );
  }

  // RECORDING state: cancel | waveform + timer | send
  return (
    <div className={wrapperClass}>
      <div className="voice-recorder-bar">
        <button
          type="button"
          className="voice-recorder-cancel"
          onClick={handleCancel}
          aria-label="Cancel recording"
        >
          <X style={{ width: 12, height: 12 }} />
          <span>Cancel</span>
        </button>

        <div className="voice-recorder-waveform">
          <canvas ref={canvasRef} />
        </div>

        <span className="voice-recorder-timer">{formatTimer(elapsedSeconds)}</span>

        <button
          type="button"
          className="voice-recorder-send"
          onClick={handleSend}
          aria-label="Send recording"
        >
          <ArrowUp style={{ width: 12, height: 12 }} />
          <span>Send</span>
        </button>
      </div>
    </div>
  );
}
