import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../Supabase/client';

const POLL_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MINUTES = 2;

export interface ActiveMeeting {
  id: string;
  room_name: string;
  started_at: string;
  max_participants: number;
  last_heartbeat: string;
}

export function useActiveMeeting(mtbId: string | undefined) {
  const [activeMeeting, setActiveMeeting] = useState<ActiveMeeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchActiveMeeting = useCallback(async () => {
    if (!mtbId) {
      setActiveMeeting(null);
      setLoading(false);
      return;
    }

    try {
      const recentThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();

      const { data, error: fetchError } = await supabase
        .from('meeting_sessions')
        .select('id, room_name, started_at, max_participants, last_heartbeat')
        .eq('mtb_id', mtbId)
        .eq('status', 'active')
        .gte('last_heartbeat', recentThreshold)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchError) {
        console.error('Failed to fetch active meeting:', fetchError);
        setError(fetchError.message);
      } else {
        setError(null);
        setActiveMeeting(data);
      }
    } catch (err) {
      console.error('Failed to fetch active meeting:', err);
      setError('Failed to check for active meetings');
    } finally {
      setLoading(false);
    }
  }, [mtbId]);

  useEffect(() => {
    fetchActiveMeeting();

    intervalRef.current = setInterval(fetchActiveMeeting, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchActiveMeeting]);

  return { activeMeeting, loading, error, refetch: fetchActiveMeeting };
}
