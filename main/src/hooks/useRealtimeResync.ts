import { useCallback, useEffect, useRef } from 'react';

// Two Realtime gaps this closes, both of which leave the UI silently stale:
// a dropped socket (backgrounded tab, sleeping laptop, lost network) delivers
// nothing and never backfills what was missed while it was down, and a tab
// that was hidden for a while can come back to a feed that reconnected
// without it noticing. Either way the fix is the same -- re-run the
// authoritative fetch -- so the resync is the same callback the first load
// used, not a second code path that could drift from it.
const MIN_RESYNC_INTERVAL_MS = 5000;

/**
 * Resync wiring for one Realtime subscription. Pass the fetch that reloads
 * whatever that subscription keeps up to date; hand the returned callback to
 * `.subscribe()`. Resyncs when the channel comes back after having been
 * connected before (a reconnect, not the first connect) and when the tab
 * becomes visible again, throttled so a burst of either doesn't refetch
 * repeatedly.
 */
export function useRealtimeResync(resync: () => void) {
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  const lastRunRef = useRef(0);
  const wasSubscribedRef = useRef(false);

  const run = useCallback(() => {
    const now = Date.now();
    if (now - lastRunRef.current < MIN_RESYNC_INTERVAL_MS) return;
    lastRunRef.current = now;
    resyncRef.current();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [run]);

  return useCallback((status: string) => {
    if (status !== 'SUBSCRIBED') return;
    // First connect needs no resync -- the initial fetch just ran. Only a
    // reconnect does, since that's the one with events missed behind it.
    if (wasSubscribedRef.current) run();
    wasSubscribedRef.current = true;
  }, [run]);
}
