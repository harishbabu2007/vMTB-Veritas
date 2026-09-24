import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../Supabase/client';

const HISTORY_POLL_INTERVAL_MS = 30_000;

export interface MeetingHistoryItem {
  id: string;
  room_name: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  max_participants: number;
  status: 'active' | 'ended';
  mom_status: 'none' | 'pending' | 'processing' | 'completed' | 'failed';
  mom_data: {
    summary: string;
    decisions: string[];
    action_items: Array<{ owner?: string; task: string }>;
    discussion_points: string[];
    generated_at: string;
    model: string;
  } | null;
  error_message: string | null;
}

/** Rows returned by get_mtb_transcripts — includes session_id for the join. */
interface TranscriptRow {
  session_id: string | null;
  meeting_id: string;
  status: string | null;
  mom: MeetingHistoryItem['mom_data'];
  error_message: string | null;
}

/** Meeting-session columns selected for the history list. */
interface SessionRow {
  id: string;
  room_name: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  max_participants: number;
  status: 'active' | 'ended';
}

export function useMeetingHistory(mtbId: string | undefined) {
  const [meetings, setMeetings] = useState<MeetingHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedOnceRef = useRef(false);

  const fetchHistory = useCallback(async (opts?: { silent?: boolean }) => {
    if (!mtbId) {
      setMeetings([]);
      setLoading(false);
      return;
    }

    // Only show the full-page loader on the first load / mtb change —
    // background polls must not flash "Loading meetings..." over the list.
    if (!opts?.silent) {
      setLoading(!loadedOnceRef.current);
    }

    try {
      const { data: sessions, error: sessionsError } = await supabase
        .from('meeting_sessions')
        .select('id, room_name, started_at, ended_at, total_duration_seconds, max_participants, status')
        .eq('mtb_id', mtbId)
        .order('started_at', { ascending: false });

      if (sessionsError) {
        console.error('Failed to fetch meeting sessions:', sessionsError);
        setError(sessionsError.message);
        return;
      }

      const { data: transcripts, error: transcriptsError } = await supabase
        .rpc('get_mtb_transcripts', { p_mtb_id: mtbId });

      if (transcriptsError) {
        // Surface (don't swallow): previously this was console-only, so an RLS
        // or RPC failure looked identical to "no transcript".
        console.error('Failed to fetch transcripts:', transcriptsError);
        setError(transcriptsError.message);
        return;
      }

      // Join on session_id (RPC returns the matched meeting_sessions.id).
      // meeting_id is the opaque Jitsi conference UUID and never equals session.id.
      const transcriptMap = new Map<string, TranscriptRow>();
      ((transcripts as TranscriptRow[] | null) || []).forEach((t) => {
        if (t.session_id) transcriptMap.set(t.session_id, t);
      });

      const items: MeetingHistoryItem[] = ((sessions as SessionRow[] | null) || []).map((session) => {
        const transcript = transcriptMap.get(session.id);
        let mom_status: MeetingHistoryItem['mom_status'] = 'none';
        let mom_data = null;
        let error_message = null;

        if (transcript) {
          mom_status = (transcript.status?.toLowerCase() as MeetingHistoryItem['mom_status']) || 'none';
          mom_data = transcript.mom;
          error_message = transcript.error_message;
        }

        return {
          id: session.id,
          room_name: session.room_name,
          started_at: session.started_at,
          ended_at: session.ended_at,
          total_duration_seconds: session.total_duration_seconds,
          max_participants: session.max_participants,
          status: session.status,
          mom_status,
          mom_data,
          error_message,
        };
      });

      setMeetings(items);
      setError(null);
      loadedOnceRef.current = true;
    } catch (err) {
      console.error('Failed to fetch meeting history:', err);
      setError('Failed to load meeting history');
    } finally {
      setLoading(false);
    }
  }, [mtbId]);

  useEffect(() => {
    loadedOnceRef.current = false;
    void fetchHistory();
  }, [fetchHistory]);

  // Keep badges live: poll while any MoM is still generating or a meeting
  // is still active (a PENDING row can appear mid-meeting).
  useEffect(() => {
    const needsPoll = meetings.some(
      (m) =>
        m.mom_status === 'pending' ||
        m.mom_status === 'processing' ||
        m.status === 'active',
    );
    if (!needsPoll) return;
    const interval = setInterval(() => {
      void fetchHistory({ silent: true });
    }, HISTORY_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [meetings, fetchHistory]);

  return { meetings, loading, error, refetch: fetchHistory };
}
