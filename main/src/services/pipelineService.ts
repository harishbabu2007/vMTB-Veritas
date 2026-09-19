/**
 * Saving document edits and following the processing they start.
 *
 * A save is two steps, and only the first one is "saving":
 *   1. commitCaseEdits() — one Postgres transaction (the commit_case_edits
 *      RPC) that records the whole batch and returns a pipeline run. When it
 *      resolves, the changes ARE saved; nothing is optimistic.
 *   2. startRun() — asks the backend to process that run (anonymize,
 *      regenerate, summarize). If this request fails the changes are still
 *      saved; the run just hasn't started, and can be started again.
 *
 * Every call carries a client-generated id, so repeating a call (double
 * click, retry after a network error, refresh mid-save) never saves or
 * processes anything twice. Processing progress is read with
 * getCaseRunState(). See main/supabase/migrations/20260918_case_pipeline_runs.sql.
 */
import { supabase } from '../Supabase/client';
import type { RedactionChange } from './redactionService';

const API_BASE = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'superseded';
export type RunKind = 'initial' | 'edit' | 'regenerate' | 'retry';

export interface PipelineRun {
  id: string;
  case_id: string;
  generation: number;
  kind: RunKind;
  status: RunStatus;
  has_uploads: boolean;
  upload_files: string[];
  materialize_done: boolean;
  anonymize_done: boolean;
  summary_done: boolean;
  documents_changed: number;
  documents_removed: number;
  documents_added: number;
  error_code: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** True when this call repeated an earlier, already-saved request. */
  duplicate?: boolean;
  /** Only from commitCaseEdits: the save emptied the case, which was archived. */
  archived?: boolean;
}

export interface CaseRunState {
  content_generation: number;
  summary_generation: number;
  verified_generation: number | null;
  summary_status: 'processing' | 'unverified' | 'verified' | 'failed';
  report_status: string | null;
  archived_at: string | null;
  run: PipelineRun | null;
  replaced_runs: number;
}

export type PipelineErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_OWNER'
  | 'NOTHING_TO_SAVE'
  | 'DOCUMENT_NOT_READY'
  | 'DOCUMENT_NOT_FOUND'
  | 'DUPLICATE_DOCUMENT'
  | 'INVALID_CHANGE'
  | 'CASE_WOULD_BE_EMPTY'
  | 'RUN_IN_PROGRESS'
  | 'REGENERATION_LIMIT'
  | 'NOTHING_TO_RETRY'
  | 'STALE_GENERATION'
  | 'SUMMARY_NOT_READY'
  | 'PATIENT_DETAILS_MISSING'
  | 'NETWORK'
  | 'UNKNOWN';

export class PipelineError extends Error {
  constructor(
    public code: PipelineErrorCode,
    /** e.g. the document name for DOCUMENT_NOT_READY:<name> */
    public detail: string | null,
    message: string
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

const KNOWN_CODES = new Set<string>([
  'NOT_AUTHENTICATED', 'NOT_OWNER', 'NOTHING_TO_SAVE', 'DOCUMENT_NOT_READY', 'DOCUMENT_NOT_FOUND',
  'DUPLICATE_DOCUMENT', 'INVALID_CHANGE', 'CASE_WOULD_BE_EMPTY', 'RUN_IN_PROGRESS', 'REGENERATION_LIMIT',
  'NOTHING_TO_RETRY', 'STALE_GENERATION', 'SUMMARY_NOT_READY', 'PATIENT_DETAILS_MISSING',
]);

/** What to tell the user for each failure. Written to be shown as-is. */
export function describePipelineError(code: PipelineErrorCode, detail: string | null = null): string {
  switch (code) {
    case 'NOT_AUTHENTICATED':
      return 'You were signed out. Your unsaved changes are kept in this tab — sign in again to save them.';
    case 'NOT_OWNER':
      return 'Only the case owner can change this case.';
    case 'NOTHING_TO_SAVE':
      return 'These changes were already saved.';
    case 'DOCUMENT_NOT_READY':
      return `"${detail ?? 'This document'}" is still being processed. You can redact it once processing finishes.`;
    case 'DOCUMENT_NOT_FOUND':
      return `"${detail ?? 'This document'}" is no longer part of this case.`;
    case 'DUPLICATE_DOCUMENT':
      return `This case already has a document named "${detail ?? ''}". Rename the file or remove the existing document first.`;
    case 'INVALID_CHANGE':
      return 'One of the changes is invalid. Reload the page and try again.';
    case 'CASE_WOULD_BE_EMPTY':
      return 'This would leave the case with no documents or notes.';
    case 'RUN_IN_PROGRESS':
      return 'An update is already in progress. It will produce a new summary when it finishes.';
    case 'REGENERATION_LIMIT':
      return 'This case has reached its limit of 5 summary regenerations.';
    case 'NOTHING_TO_RETRY':
      return 'There is no failed update to retry.';
    case 'STALE_GENERATION':
      return 'This case changed since you opened it. Reload to see the latest version.';
    case 'SUMMARY_NOT_READY':
      return 'The updated summary isn’t ready yet. Wait for it to finish, then review it.';
    case 'PATIENT_DETAILS_MISSING':
      return 'Add the patient’s age and sex before verifying.';
    case 'NETWORK':
      return 'Couldn’t reach the server. Check your connection and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

function toPipelineError(err: unknown): PipelineError {
  if (err instanceof PipelineError) return err;
  const raw = (err as { message?: string } | null)?.message ?? String(err);
  const [code, ...rest] = raw.split(':');
  if (KNOWN_CODES.has(code)) {
    const detail = rest.length ? rest.join(':') : null;
    return new PipelineError(code as PipelineErrorCode, detail, describePipelineError(code as PipelineErrorCode, detail));
  }
  const status = (err as { status?: number; code?: string } | null);
  if (status?.code === 'PGRST301' || /JWT|jwt expired|not authenticated/i.test(raw)) {
    return new PipelineError('NOT_AUTHENTICATED', null, describePipelineError('NOT_AUTHENTICATED'));
  }
  if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return new PipelineError('NETWORK', null, describePipelineError('NETWORK'));
  }
  return new PipelineError('UNKNOWN', raw, describePipelineError('UNKNOWN'));
}

async function callRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  let result;
  try {
    result = await supabase.rpc(name, params);
  } catch (err) {
    throw toPipelineError(err);
  }
  if (result.error) throw toPipelineError(result.error);
  return result.data as T;
}

export interface CommitInput {
  caseId: string;
  sessionId: string;
  documents: { documentFilename: string; changes: RedactionChange[] }[];
  deleteFiles: string[];
  uploadFiles: { file_name: string; size: string; type: string }[];
  additionalData: { title: string; content: string } | null;
  /** Required ('archive') when the save leaves the case with no documents and no notes. */
  emptyAction?: 'archive' | null;
}

/** Save a batch of document edits. Resolves only once they are durably saved. */
export function commitCaseEdits(input: CommitInput): Promise<PipelineRun> {
  return callRpc<PipelineRun>('commit_case_edits', {
    p_case_id: input.caseId,
    p_session_id: input.sessionId,
    p_documents: input.documents.map((d) => ({
      document_filename: d.documentFilename,
      changes: d.changes.map((c) =>
        c.action === 'add'
          ? { action: 'add', page_number: c.pageNumber, bbox: c.bbox, style: c.style }
          : { action: 'remove', redaction_id: c.redactionId }
      ),
    })),
    p_delete_files: input.deleteFiles,
    p_upload_files: input.uploadFiles,
    p_additional_data: input.additionalData,
    p_empty_action: input.emptyAction ?? null,
  });
}

export const startRegeneration = (caseId: string, sessionId: string) =>
  callRpc<PipelineRun>('start_regeneration', { p_case_id: caseId, p_session_id: sessionId });

export const retryCaseRun = (caseId: string, sessionId: string) =>
  callRpc<PipelineRun>('retry_case_run', { p_case_id: caseId, p_session_id: sessionId });

export const startInitialRun = (caseId: string, sessionId: string) =>
  callRpc<PipelineRun>('start_initial_run', { p_case_id: caseId, p_session_id: sessionId });

export const getCaseRunState = (caseId: string) =>
  callRpc<CaseRunState>('get_case_run_state', { p_case_id: caseId });

/**
 * Ask the backend to process a saved run. Safe to call again for the same
 * run (processing is idempotent). Retries briefly on network errors; if it
 * still fails, the run stays pending and is reported as "didn't start" after
 * two minutes, with a Retry.
 */
export async function startRun(runId: string): Promise<void> {
  let lastError: unknown = null;
  for (const delay of [0, 800, 2400]) {
    if (delay) await new Promise((r) => window.setTimeout(r, delay));
    try {
      const response = await fetch(`${API_BASE}/trigger-apply-redaction-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId }),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status < 500) break;
    } catch (err) {
      lastError = err;
    }
  }
  console.error('[pipelineService] startRun failed', runId, lastError);
  throw new PipelineError('NETWORK', null, 'Your changes are saved, but processing couldn’t be started.');
}

/** A fresh id for one save / regenerate / retry request. */
export const newRequestId = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Cross-tab notice: a save in one tab tells other tabs showing the same case
// to refresh (BroadcastChannel is per-origin, so this never leaves the browser).
// ---------------------------------------------------------------------------

const channelName = (caseId: string) => `vmtb-case-${caseId}`;

export function announceCaseChanged(caseId: string, tabId: string) {
  try {
    const channel = new BroadcastChannel(channelName(caseId));
    channel.postMessage({ type: 'case-changed', tabId });
    channel.close();
  } catch {
    // BroadcastChannel unavailable — other tabs still pick it up by polling.
  }
}

export function onCaseChangedElsewhere(caseId: string, tabId: string, handler: () => void): () => void {
  try {
    const channel = new BroadcastChannel(channelName(caseId));
    channel.onmessage = (event) => {
      if (event.data?.type === 'case-changed' && event.data.tabId !== tabId) handler();
    };
    return () => channel.close();
  } catch {
    return () => {};
  }
}

/** Stable per-tab id (survives refresh, differs between tabs). */
export function getTabId(): string {
  try {
    let id = window.sessionStorage.getItem('vmtb:tab-id');
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem('vmtb:tab-id', id);
    }
    return id;
  } catch {
    return 'tab';
  }
}

// ---------------------------------------------------------------------------
// Summary verification and manual edits. Both are refused server-side while a
// run is producing a new summary, or when `generation` (the version of the
// case the user was looking at) is no longer current.
// ---------------------------------------------------------------------------

/** Returns the updated `cases` row. */
export async function verifyCaseSummary(caseId: string, generation: number): Promise<Record<string, unknown> | null> {
  const rows = await callRpc<Record<string, unknown>[]>('verify_case_summary', {
    p_case_id: caseId,
    p_generation: generation,
  });
  return rows?.[0] ?? null;
}

export interface SummaryEdit {
  summary: string;
  patientName: string;
  patientAge: number | null;
  patientSex: string | null;
  cancerType: string;
}

/** Returns the updated `cases` row. */
export async function saveCaseSummaryEdit(
  caseId: string,
  generation: number,
  edit: SummaryEdit,
  verify = false
): Promise<Record<string, unknown> | null> {
  const rows = await callRpc<Record<string, unknown>[]>('save_case_summary_edit', {
    p_case_id: caseId,
    p_generation: generation,
    p_summary: edit.summary,
    p_patient_name: edit.patientName,
    p_patient_age: edit.patientAge,
    p_patient_sex: edit.patientSex ?? '',
    p_cancer_type: edit.cancerType,
    p_verify: verify,
  });
  return rows?.[0] ?? null;
}
