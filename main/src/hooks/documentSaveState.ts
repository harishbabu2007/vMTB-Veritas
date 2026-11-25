import type { CommitInput } from '../services/pipelineService';

/**
 * The Reports tab's save flow as one typed state.
 *
 * It used to be four independent `useState`s in `Reports.tsx` (`committing`,
 * `saveProblem`, `lastSave`, `emptyPrompt`) plus a re-entrancy `ref`, so
 * "saving" and "saved, but the previous save is still being applied" and
 * "saving and also showing an old error" were all representable. They aren't
 * any more: `selectSaveState` maps one reducer state onto one union, and every
 * consumer switches on it.
 *
 * The real flow:
 *
 *   clean ──edit──▶ dirty ──save──▶ saving ──┬─▶ saved
 *     ▲                  ▲                   └─▶ failed ──discard──▶ clean
 *     └──────────────────┴── discard
 *
 * plus two states outside that loop:
 *
 *   - `needs-decision`: the save was refused because the case would be left
 *     with no documents and no notes, and the owner must pick "add data" or
 *     "archive". Whether that question is on screen is `pendingEmpty` itself,
 *     not this union: it has to stay up while the archive it triggered is
 *     still in flight, when this union reads `saving`.
 *   - `saved` carrying the run id: the last save's changes may still be being
 *     applied by the backend. `lastSaved` deliberately outlives a later
 *     failed attempt, so a retry that fails doesn't blank out the previous
 *     save's progress. The per-document "Updating…" chips read it straight
 *     from the session rather than through this union.
 */

/** What went wrong with the last save attempt, in the form the strip shows it. */
export interface SaveProblem {
  message: string;
  /** Offer "Try again" (the same save, same id — never saved twice). */
  canRetry: boolean;
}

/** A save held back because it would leave the case with nothing in it. */
export interface PendingEmptyArchive {
  sessionId: string;
  documents: CommitInput['documents'];
  deleteFiles: string[];
  additionalData: { title: string; content: string } | null;
}

/** The last save that actually landed. */
export interface SavedBatch {
  runId: string;
  filenames: string[];
}

export type SaveState =
  /** Nothing unsaved, nothing in flight. */
  | { kind: 'clean' }
  /** Unsaved changes held in this tab. */
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; runId: string; filenames: string[] }
  | { kind: 'failed'; problem: SaveProblem }
  /** The empty-case question is open; nothing is in flight. */
  | { kind: 'needs-decision' };

export type SaveAttempt = 'idle' | 'saving' | 'failed';

export interface SaveMachineState {
  attempt: SaveAttempt;
  problem: SaveProblem | null;
  /** The empty-case save waiting on an answer; kept so leaving the page can apply it. */
  pendingEmpty: PendingEmptyArchive | null;
  lastSaved: SavedBatch | null;
}

export const initialSaveMachine: SaveMachineState = {
  attempt: 'idle',
  problem: null,
  pendingEmpty: null,
  lastSaved: null,
};

export type SaveAction =
  | { type: 'start' }
  | { type: 'saved'; batch: SavedBatch }
  | { type: 'failed'; problem: SaveProblem }
  | { type: 'needs-decision'; pending: PendingEmptyArchive }
  /** The owner answered (or dismissed) the empty-case question. */
  | { type: 'decided' }
  /** Discard the draft, or nothing left to save: forget the problem. */
  | { type: 'reset' };

export function saveMachineReducer(state: SaveMachineState, action: SaveAction): SaveMachineState {
  switch (action.type) {
    case 'start':
      // A new attempt supersedes the previous problem, but not the previous
      // successful save (its run may still be applying).
      return { ...state, attempt: 'saving', problem: null };
    case 'saved':
      return { attempt: 'idle', problem: null, pendingEmpty: null, lastSaved: action.batch };
    case 'failed':
      return { ...state, attempt: 'failed', problem: action.problem };
    case 'needs-decision':
      return { ...state, attempt: 'idle', problem: null, pendingEmpty: action.pending };
    case 'decided':
      return { ...state, pendingEmpty: null };
    case 'reset':
      return {
        ...state,
        attempt: 'idle',
        problem: null,
        lastSaved: state.lastSaved,
      };
  }
}

/**
 * The one union `Reports.tsx` and `CaseUpdateStatus` read.
 * `pendingCount` is the session's unsaved-change count, which is data, not
 * flow — so it is an argument rather than reducer state.
 *
 * Unsaved changes are checked before `lastSaved`, so making an edit after a
 * save reads as `dirty` rather than claiming the tab is still `saved`.
 */
export function selectSaveState(state: SaveMachineState, pendingCount: number): SaveState {
  if (state.attempt === 'saving') return { kind: 'saving' };
  if (state.attempt === 'failed' && state.problem) return { kind: 'failed', problem: state.problem };
  // The empty-case question outranks everything below it: while it is open
  // the draft is neither plain-dirty nor plain-saved. Whether it is *on
  // screen* is `state.pendingEmpty` directly — it stays open while an
  // in-flight archive is running, which `attempt: 'saving'` would hide.
  if (state.pendingEmpty) return { kind: 'needs-decision' };
  if (pendingCount > 0) return { kind: 'dirty' };
  return state.lastSaved ? { kind: 'saved', ...state.lastSaved } : { kind: 'clean' };
}
