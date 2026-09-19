import { useCallback, useState } from 'react';
import { newRequestId, retryCaseRun, startRun } from '../services/pipelineService';
import type { CaseRunStateHandle } from './useCaseRunState';
import { showToast } from '../utils/toast';

/**
 * The two recovery actions the status strip offers for a case's latest run,
 * shared by every page that shows it:
 *   - startCurrentRun: the save succeeded but asking the backend to process
 *     it failed — ask again (processing is idempotent).
 *   - retryFailedRun: processing failed — start a new run of the same work
 *     (retry_case_run; not counted against the regeneration cap).
 */
export function useRunActions(caseId: string | undefined, runState: CaseRunStateHandle) {
  const [startFailed, setStartFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { refresh } = runState;

  const start = useCallback(
    async (runId: string) => {
      setStartFailed(false);
      try {
        await startRun(runId);
      } catch {
        setStartFailed(true);
      }
      refresh();
    },
    [refresh]
  );

  const startCurrentRun = useCallback(async () => {
    const runId = runState.state?.run?.id;
    if (runId) await start(runId);
  }, [runState.state, start]);

  const retryFailedRun = useCallback(async () => {
    if (!caseId || retrying) return;
    setRetrying(true);
    try {
      const run = await retryCaseRun(caseId, newRequestId());
      await refresh();
      await start(run.id);
    } catch (err) {
      showToast.error(err instanceof Error ? err.message : "Couldn't retry. Try again.");
    } finally {
      setRetrying(false);
    }
  }, [caseId, retrying, refresh, start]);

  return { start, startFailed, setStartFailed, retrying, startCurrentRun, retryFailedRun };
}
