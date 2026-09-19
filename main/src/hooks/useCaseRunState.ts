import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaseRunState,
  getCaseRunState,
  getTabId,
  onCaseChangedElsewhere,
} from '../services/pipelineService';

const ACTIVE_POLL_MS = 4000;
const IDLE_POLL_MS = 30000;

/**
 * Live processing state of a case (its latest pipeline run, summary status
 * and generations), for the status strip and for enabling/disabling actions.
 * Polls quickly while a run is pending or running and slowly otherwise,
 * pauses while the tab is hidden, and refreshes at once when another tab
 * saves changes to the same case. Reading it also expires stuck runs
 * server-side, so a run that died shows up as failed.
 */
export function useCaseRunState(caseId: string | undefined, onChange?: (state: CaseRunState) => void) {
  const [state, setState] = useState<CaseRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!caseId) return null;
    try {
      const next = await getCaseRunState(caseId);
      setState(next);
      setError(null);
      const key = `${next.content_generation}:${next.summary_generation}:${next.summary_status}:${next.run?.status}:${next.run?.id}`;
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        onChangeRef.current?.(next);
      }
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t check this case’s status.');
      return null;
    }
  }, [caseId]);

  const active = state?.run?.status === 'pending' || state?.run?.status === 'running';

  useEffect(() => {
    if (!caseId) return;
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!cancelled) timer = window.setTimeout(tick, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [caseId, active, refresh]);

  useEffect(() => {
    if (!caseId) return;
    return onCaseChangedElsewhere(caseId, getTabId(), () => {
      setChangedElsewhere(true);
      refresh();
    });
  }, [caseId, refresh]);

  return {
    state,
    error,
    refresh,
    /** True while a run is pending or running. */
    active,
    /** Another tab saved changes to this case since this one loaded. */
    changedElsewhere,
    dismissChangedElsewhere: () => setChangedElsewhere(false),
  };
}

export type CaseRunStateHandle = ReturnType<typeof useCaseRunState>;
