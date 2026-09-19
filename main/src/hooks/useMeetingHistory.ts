import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../Supabase/client';

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

export function useMeetingHistory(mtbId: string | undefined) {
  const [meetings, setMeetings] = useState<MeetingHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!mtbId) {
      setMeetings([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

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
        console.error('Failed to fetch transcripts:', transcriptsError);
      }

      const transcriptMap = new Map<string, any>();
      (transcripts || []).forEach((t: any) => {
        transcriptMap.set(t.meeting_id, t);
      });

      const items: MeetingHistoryItem[] = (sessions || []).map((session: any) => {
        const transcript: any = transcriptMap.get(session.id);
        let mom_status: MeetingHistoryItem['mom_status'] = 'none';
        let mom_data = null;
        let error_message = null;

        if (transcript) {
          mom_status = transcript.status?.toLowerCase() || 'none';
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
    } catch (err) {
      console.error('Failed to fetch meeting history:', err);
      setError('Failed to load meeting history');
    } finally {
      setLoading(false);
    }
  }, [mtbId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { meetings, loading, error, refetch: fetchHistory };
}
