import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CircleDot, Loader2, RotateCw } from 'lucide-react';
import type { CaseRunState, PipelineRun } from '../services/pipelineService';
import { useDismissed } from '../hooks/useDismissed';
import { DismissButton } from './DismissButton';

export interface SaveProblem {
  message: string;
  /** Offer "Try again" (the same save, same id — never saved twice). */
  canRetry: boolean;
}

interface CaseUpdateStatusProps {
  /** Scopes a closed notice to this case, so closing it here doesn't hide another case's. */
  caseId?: string;
  runState: CaseRunState | null;
  isOwner: boolean;
  /** Unsaved changes held in this tab. */
  unsavedCount?: number;
  saving?: boolean;
  saveProblem?: SaveProblem | null;
  /** The last save succeeded but asking the backend to process it failed. */
  startFailed?: boolean;
  busy?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  onRetrySave?: () => void;
  onStartRun?: () => void;
  onRetryRun?: () => void;
  className?: string;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the current run is doing, in the user's terms. */
export function describeRunStage(run: PipelineRun): string {
  if (run.kind === 'regenerate') return 'Generating a new summary';
  if (!run.materialize_done) {
    const parts = [];
    if (run.documents_removed) parts.push(`removing ${plural(run.documents_removed, 'document', 'documents')}`);
    if (run.documents_changed) parts.push(`updating redactions in ${plural(run.documents_changed, 'document', 'documents')}`);
    if (run.documents_added) parts.push(`adding ${plural(run.documents_added, 'document', 'documents')}`);
    const text = parts.join(', ') || 'preparing the update';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  if (run.has_uploads && !run.anonymize_done) return 'Anonymizing new documents, then generating the summary';
  if (!run.summary_done) return 'Generating the updated summary';
  return 'Finishing up';
}

function elapsed(since: string, now: number) {
  const minutes = Math.floor((now - new Date(since).getTime()) / 60000);
  if (minutes < 1) return 'started just now';
  return `started ${minutes} min ago`;
}

type Tone = 'amber' | 'blue' | 'red' | 'green';

const TONES: Record<Tone, string> = {
  amber: 'bg-warning-bg border-warning-border text-warning-text',
  blue: 'bg-info-bg border-info-border text-info-text',
  red: 'bg-danger-bg border-danger-border text-danger-text',
  green: 'bg-success-bg border-success-border text-success-text',
};

function Button({ onClick, children, primary, disabled }: { onClick?: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap ${
        primary ? 'text-on-solid bg-primary-solid hover:opacity-90' : 'text-text bg-surface border border-border hover:bg-surface-hover'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The one place a case says whether its changes are unsaved, saving, saved
 * and processing, failed, or waiting for verification. Exactly one of those
 * at a time, in priority order, with the action that moves it forward.
 */
export function CaseUpdateStatus({
  caseId, runState, isOwner, unsavedCount = 0, saving, saveProblem, startFailed, busy,
  onSave, onDiscard, onRetrySave, onStartRun, onRetryRun, className = '',
}: CaseUpdateStatusProps) {
  const [now, setNow] = useState(Date.now());
  const run = runState?.run ?? null;
  const running = run?.status === 'pending' || run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, [running]);

  let tone: Tone = 'blue';
  let icon: React.ReactNode = null;
  let title = '';
  let detail: string | null = null;
  let actions: React.ReactNode = null;
  let hidden = false;
  // Only purely informational states can be closed, keyed to the exact run or
  // summary version they're about so the next update shows again. Unsaved
  // changes, save errors and failures stay until they're resolved.
  let dismissKey: string | null = null;

  const latestFailed = run?.status === 'failed' && runState && run.generation === runState.content_generation;
  const needsVerification =
    isOwner && runState && !running &&
    runState.summary_status === 'unverified' &&
    runState.summary_generation === runState.content_generation &&
    runState.verified_generation !== runState.content_generation;

  if (saving) {
    tone = 'blue';
    icon = <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />;
    title = 'Saving…';
  } else if (saveProblem) {
    tone = 'red';
    icon = <AlertTriangle className="w-4 h-4" aria-hidden="true" />;
    title = 'Not saved';
    detail = saveProblem.message;
    // A problem a plain retry won't fix (signed out, case would be empty…)
    // still leaves the draft actionable: fix the cause, then save or discard.
    actions = saveProblem.canRetry && onRetrySave
      ? <Button primary onClick={onRetrySave} disabled={busy}>Try again</Button>
      : unsavedCount > 0
        ? (
          <>
            {onDiscard && <Button onClick={onDiscard} disabled={busy}>Discard</Button>}
            {onSave && <Button primary onClick={onSave} disabled={busy}>Save changes</Button>}
          </>
        )
        : null;
  } else if (startFailed && running) {
    tone = 'red';
    icon = <AlertTriangle className="w-4 h-4" aria-hidden="true" />;
    title = 'Saved, but processing didn’t start';
    detail = 'Your changes are saved.';
    actions = onStartRun ? <Button primary onClick={onStartRun} disabled={busy}><RotateCw className="w-4 h-4" />Start processing</Button> : null;
  } else if (unsavedCount > 0) {
    tone = 'amber';
    icon = <CircleDot className="w-4 h-4" aria-hidden="true" />;
    title = `Unsaved changes (${unsavedCount})`;
    detail = running ? 'An earlier update is still being applied. Saving now replaces it with your latest changes.' : null;
    actions = (
      <>
        {onDiscard && <Button onClick={onDiscard} disabled={busy}>Discard</Button>}
        {onSave && <Button primary onClick={onSave} disabled={busy}>Save changes</Button>}
      </>
    );
  } else if (running && run) {
    tone = 'blue';
    icon = <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />;
    const replaced = (runState?.replaced_runs ?? 0) > 0;
    title = replaced ? 'Saved. Your newer changes replace the update in progress' : 'Saved. Applying your changes';
    detail = `${describeRunStage(run)} · ${elapsed(run.created_at, now)}. You can keep working.`;
    dismissKey = `case-run:${run.id}`;
  } else if (latestFailed && run) {
    tone = 'red';
    icon = <AlertTriangle className="w-4 h-4" aria-hidden="true" />;
    title = run.error_code === 'NO_CONTENT' ? 'Nothing to summarize' : 'Update failed';
    detail = `${run.error || 'Processing failed.'}${run.error_code === 'NO_CONTENT' ? '' : ' Your changes are saved.'}`;
    actions = isOwner && onRetryRun && run.error_code !== 'NO_CONTENT'
      ? <Button primary onClick={onRetryRun} disabled={busy}><RotateCw className="w-4 h-4" />Retry</Button>
      : null;
  } else if (needsVerification) {
    tone = 'amber';
    icon = <Check className="w-4 h-4" aria-hidden="true" />;
    const neverVerified = runState?.verified_generation == null;
    title = neverVerified ? 'Summary ready. Review and verify it' : 'Updated. Review and verify the new summary';
    detail = neverVerified
      ? 'Review the summary below, then verify at the bottom of the page.'
      : 'MTB members keep seeing the last verified version until you verify at the bottom of the page.';
    const scope = caseId ?? run?.case_id;
    dismissKey = scope ? `case-verify:${scope}:${runState?.content_generation}` : null;
  } else {
    hidden = true;
  }

  const [dismissed, dismiss] = useDismissed(dismissKey);
  if (hidden || dismissed) return null;

  return (
    <div
      className={`flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 rounded-lg border ${TONES[tone]} ${className}`}
      role={tone === 'red' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <div className="text-sm min-w-0">
          <p className="font-medium">{title}</p>
          {detail && <p className="opacity-90">{detail}</p>}
        </div>
      </div>
      {(actions || dismissKey) && (
        <div className="flex items-center gap-2">
          {actions}
          {dismissKey && <DismissButton onClick={dismiss} label="Dismiss this notice" />}
        </div>
      )}
    </div>
  );
}
