import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, Users, FileText, AlertCircle, CheckCircle2, Loader2, ClipboardList } from 'lucide-react';
import { Layout } from '../components/Layout';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';

const MOM_REFRESH_INTERVAL_MS = 60_000;

interface MeetingSession {
  id: string;
  mtb_id: string;
  room_name: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  max_participants: number;
  status: 'active' | 'ended';
}

interface MomData {
  summary: string;
  decisions: string[];
  action_items: Array<{ owner?: string; task: string }>;
  discussion_points: string[];
  generated_at: string;
  model: string;
}

interface Transcript {
  id: string;
  meeting_id: string;
  session_id: string | null;
  status: string;
  mom: MomData | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function MeetingDetail() {
  const { mtbId, meetingId } = useParams<{ mtbId: string; meetingId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [session, setSession] = useState<MeetingSession | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!meetingId || !mtbId) return;

    try {
      const { data: sessionData, error: sessionError } = await supabase
        .from('meeting_sessions')
        .select('*')
        .eq('id', meetingId)
        .eq('mtb_id', mtbId)
        .maybeSingle();

      if (sessionError) {
        console.error('Failed to fetch meeting session:', sessionError);
        setError(sessionError.message);
        return;
      }

      if (!sessionData) {
        setError('Meeting not found');
        return;
      }

      setSession(sessionData);
      setError(null);

      const { data: transcriptData, error: transcriptError } = await supabase
        .rpc('get_mtb_transcripts', { p_mtb_id: mtbId });

      if (transcriptError) {
        // Don't wipe a previously good transcript on a transient RPC failure.
        console.error('Failed to fetch transcripts:', transcriptError);
        return;
      }

      // session_id is the matched meeting_sessions.id from the RPC.
      // meeting_id is the Jitsi conference UUID and never equals route meetingId.
      const match = ((transcriptData as Transcript[] | null) || []).find(
        (t) => t.session_id === meetingId,
      );
      setTranscript(match || null);
    } catch (err) {
      console.error('Failed to fetch meeting data:', err);
      setError('Failed to load meeting details');
    } finally {
      setLoading(false);
    }
  }, [meetingId, mtbId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Poll while MoM is generating, or while no transcript row is visible yet
  // and the meeting is recent (the PENDING row can appear after mount —
  // previously `if (!transcript) return` meant we never started polling).
  useEffect(() => {
    const status = transcript?.status?.toLowerCase();
    const isGenerating = status === 'pending' || status === 'processing';
    const sessionEndedMs = session?.ended_at ? Date.parse(session.ended_at) : null;
    const recentlyActive =
      session?.status === 'active' ||
      (sessionEndedMs !== null && Date.now() - sessionEndedMs < 15 * 60_000);
    const shouldPoll = isGenerating || (!transcript && recentlyActive);
    if (!shouldPoll) return;
    const interval = setInterval(() => {
      void fetchData();
    }, MOM_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [transcript?.status, transcript, session?.status, session?.ended_at, fetchData]);

  if (loading) {
    return (
      <Layout>
        <div className="text-center py-12">
          <Loader2 className="w-6 h-6 text-text-faint animate-spin mx-auto mb-3" />
          <p className="text-sm text-text-subtle">Loading meeting details...</p>
        </div>
      </Layout>
    );
  }

  if (error || !session) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-sm text-danger">{error || 'Meeting not found'}</p>
          <button
            onClick={() => navigate(`/mtb/${mtbId}`)}
            className="mt-3 text-sm text-info hover:text-info-text"
          >
            Back to MTB
          </button>
        </div>
      </Layout>
    );
  }

  const momStatus = transcript?.status?.toLowerCase() || 'none';

  return (
    <Layout>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        {/* Back button */}
        <button
          onClick={() => navigate(`/mtb/${mtbId}`)}
          className="flex items-center gap-1.5 text-sm text-text-subtle hover:text-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to MTB
        </button>

        {/* Meeting metadata */}
        <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
          <h1 className={`font-bold ${isMobile ? 'text-lg' : 'text-xl'} mb-4 text-text-muted`}>
            Meeting Details
          </h1>
          <div className={`grid ${isMobile ? 'grid-cols-2' : 'grid-cols-4'} gap-4`}>
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-text-faint flex-shrink-0" />
              <div>
                <p className="text-xs text-text-subtle">Date</p>
                <p className="text-sm font-medium text-text">{formatDate(session.started_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-text-faint flex-shrink-0" />
              <div>
                <p className="text-xs text-text-subtle">Time</p>
                <p className="text-sm font-medium text-text">{formatTime(session.started_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-text-faint flex-shrink-0" />
              <div>
                <p className="text-xs text-text-subtle">Duration</p>
                <p className="text-sm font-medium text-text">{formatDuration(session.total_duration_seconds)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-text-faint flex-shrink-0" />
              <div>
                <p className="text-xs text-text-subtle">Max Participants</p>
                <p className="text-sm font-medium text-text">{session.max_participants}</p>
              </div>
            </div>
          </div>
          {session.status === 'active' && (
            <div className="mt-4 flex items-center gap-2">
              <span className="w-2 h-2 bg-success-solid rounded-full animate-pulse" />
              <span className="text-sm font-medium text-success">Meeting in progress</span>
            </div>
          )}
        </div>

        {/* Minutes of Meeting */}
        <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <ClipboardList className="w-5 h-5 text-primary" />
            <h2 className={`font-bold ${isMobile ? 'text-base' : 'text-lg'} text-text-muted`}>
              Minutes of Meeting
            </h2>
          </div>

          {/* MoM Status: Pending / Processing */}
          {(momStatus === 'pending' || momStatus === 'processing') && (
            <div className="bg-warning-bg border border-warning-border rounded-lg p-6 text-center">
              <Loader2 className="w-8 h-8 text-warning animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-warning-text">Transcription is being generated</p>
              <p className="text-xs text-warning mt-1">
                Meeting transcript and minutes of meeting are processing. This page will refresh automatically every minute.
              </p>
            </div>
          )}

          {/* MoM Status: Failed */}
          {momStatus === 'failed' && (
            <div className="bg-danger-bg border border-danger-border rounded-lg p-6 text-center">
              <AlertCircle className="w-8 h-8 text-danger mx-auto mb-3" />
              <p className="text-sm font-medium text-danger-text">MoM generation failed</p>
              {transcript?.error_message && (
                <p className="text-xs text-danger mt-1">{transcript.error_message}</p>
              )}
            </div>
          )}

          {/* MoM Status: None (no transcript) */}
          {momStatus === 'none' && (
            <div className="bg-bg border border-border rounded-lg p-6 text-center">
              <FileText className="w-8 h-8 text-text-faint mx-auto mb-3" />
              <p className="text-sm text-text-subtle">No transcript available for this meeting.</p>
              <p className="text-xs text-text-subtle mt-1">Transcripts are only available for meetings with live transcription enabled.</p>
            </div>
          )}

          {/* MoM Status: Completed without MoM payload (LLM skipped / best-effort null) */}
          {momStatus === 'completed' && !transcript?.mom && (
            <div className="bg-bg border border-border rounded-lg p-6 text-center">
              <FileText className="w-8 h-8 text-text-faint mx-auto mb-3" />
              <p className="text-sm text-text-subtle">Transcript processed, but no minutes of meeting were generated.</p>
              <p className="text-xs text-text-subtle mt-1">MoM generation is best-effort and may have been disabled for this run.</p>
            </div>
          )}

          {/* MoM Status: Completed — show content */}
          {momStatus === 'completed' && transcript?.mom && (
            <div className="space-y-5">
              {/* Summary */}
              <div>
                <h3 className="text-sm font-semibold text-text-muted mb-2">Summary</h3>
                <p className="text-sm text-text-muted leading-relaxed whitespace-pre-wrap">{transcript.mom.summary}</p>
              </div>

              {/* Decisions */}
              {transcript.mom.decisions && transcript.mom.decisions.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-muted mb-2">Decisions</h3>
                  <ul className="space-y-1.5">
                    {transcript.mom.decisions.map((decision, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
                        <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                        <span>{decision}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Action Items */}
              {transcript.mom.action_items && transcript.mom.action_items.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-muted mb-2">Action Items</h3>
                  <ul className="space-y-1.5">
                    {transcript.mom.action_items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
                        <span className="w-4 h-4 rounded border border-info-border flex-shrink-0 mt-0.5 flex items-center justify-center text-[10px] font-medium text-info">
                          {i + 1}
                        </span>
                        <span>
                          {item.owner && <span className="font-medium text-text">{item.owner}: </span>}
                          {item.task}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Discussion Points */}
              {transcript.mom.discussion_points && transcript.mom.discussion_points.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-muted mb-2">Discussion Points</h3>
                  <ul className="space-y-1.5">
                    {transcript.mom.discussion_points.map((point, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
                        <span className="w-1 h-1 bg-text-faint rounded-full flex-shrink-0 mt-2" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Metadata */}
              <div className="pt-3 border-t border-border">
                <p className="text-xs text-text-subtle">
                  Generated {formatDate(transcript.mom.generated_at)} at {formatTime(transcript.mom.generated_at)}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
