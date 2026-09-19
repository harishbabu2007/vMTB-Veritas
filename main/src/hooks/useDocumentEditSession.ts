import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../Supabase/client';
import type { RedactionBBox, RedactionChange, RedactionStyle } from '../services/redactionService';

/**
 * Everything a case owner has changed on the Reports tab that isn't saved
 * yet: redaction edits on any number of documents, documents marked for
 * removal, new uploads, and the "Your data" text. The whole draft is saved in
 * one commit_case_edits call; its session id is that call's idempotency key,
 * so a repeated save can never apply the same edits twice.
 *
 * The draft (except uploads — File objects can't be serialized) is mirrored
 * to sessionStorage: it survives a refresh and in-app navigation in this tab,
 * and never leaks into another tab of the same case. On load, a stored draft
 * whose session id already has a pipeline run was in fact saved (the page was
 * refreshed mid-save) and is cleared instead of restored. Storage is a
 * convenience only: every access is guarded and the session works without it.
 */

export type LocalChange =
  | { localId: string; action: 'add'; pageNumber: number; bbox: RedactionBBox; style: RedactionStyle }
  | { localId: string; action: 'remove'; redactionId: string };

export interface AdditionalDocument {
  title: string;
  content: string;
}

interface StoredDraft {
  sessionId: string;
  redactions: Record<string, LocalChange[]>;
  deletes: string[];
  additionalData: AdditionalDocument | null;
}

export interface SessionSnapshot extends StoredDraft {
  uploads: File[];
}

const storageKey = (caseId: string) => `vmtb:document-edit-session:${caseId}`;

function newSessionId() {
  return crypto.randomUUID();
}

function emptyDraft(): StoredDraft {
  return { sessionId: newSessionId(), redactions: {}, deletes: [], additionalData: null };
}

function draftChangeCount(d: StoredDraft) {
  return (
    Object.values(d.redactions).reduce((n, list) => n + list.length, 0) +
    d.deletes.length +
    (d.additionalData ? 1 : 0)
  );
}

function readStoredDraft(caseId: string): StoredDraft | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(caseId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed || typeof parsed.sessionId !== 'string') return null;
    const draft: StoredDraft = {
      sessionId: parsed.sessionId,
      redactions: parsed.redactions || {},
      deletes: Array.isArray(parsed.deletes) ? parsed.deletes : [],
      additionalData: parsed.additionalData || null,
    };
    return draftChangeCount(draft) > 0 ? draft : null;
  } catch {
    return null;
  }
}

function writeStoredDraft(caseId: string, draft: StoredDraft) {
  try {
    if (draftChangeCount(draft) === 0) {
      window.sessionStorage.removeItem(storageKey(caseId));
    } else {
      window.sessionStorage.setItem(storageKey(caseId), JSON.stringify(draft));
    }
  } catch {
    // Storage unavailable (private window, blocked site data) — session still works in memory.
  }
}

export function toRedactionChanges(changes: LocalChange[]): RedactionChange[] {
  return changes.map((c) =>
    c.action === 'add'
      ? { action: 'add', pageNumber: c.pageNumber, bbox: c.bbox, style: c.style }
      : { action: 'remove', redactionId: c.redactionId }
  );
}

export function useDocumentEditSession(caseId: string) {
  const [draft, setDraft] = useState<StoredDraft>(emptyDraft);
  const [uploads, setUploads] = useState<File[]>([]);
  // What happened to a draft found in storage on load: restored (still
  // unsaved) or already saved (the page was refreshed mid-save).
  const [recovered, setRecovered] = useState<'restored' | 'already-saved' | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(false);
    setUploads([]);
    const stored = readStoredDraft(caseId);
    if (!stored) {
      setDraft(emptyDraft());
      setHydrated(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('case_pipeline_runs').select('id').eq('id', stored.sessionId).maybeSingle();
      if (cancelled) return;
      if (!error && data) {
        setDraft(emptyDraft());
        setRecovered('already-saved');
      } else {
        setDraft(stored);
        setRecovered('restored');
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  useEffect(() => {
    // Until the stored draft has been checked, don't overwrite it.
    if (!hydrated) return;
    writeStoredDraft(caseId, draft);
  }, [caseId, draft, hydrated]);

  const setDocumentChanges = useCallback((filename: string, changes: LocalChange[]) => {
    setDraft((prev) => {
      const redactions = { ...prev.redactions };
      if (changes.length === 0) delete redactions[filename];
      else redactions[filename] = changes;
      return { ...prev, redactions };
    });
  }, []);

  const toggleDelete = useCallback((filename: string) => {
    setDraft((prev) => ({
      ...prev,
      deletes: prev.deletes.includes(filename)
        ? prev.deletes.filter((f) => f !== filename)
        : [...prev.deletes, filename],
    }));
  }, []);

  /** Drop every unsaved change to one document (redactions and a pending removal). */
  const discardDocument = useCallback((filename: string) => {
    setDraft((prev) => {
      const redactions = { ...prev.redactions };
      delete redactions[filename];
      return { ...prev, redactions, deletes: prev.deletes.filter((f) => f !== filename) };
    });
  }, []);

  /**
   * Drop every unsaved change made in the document viewer. Uploads and
   * "Your data" edits queued from the grid are not viewer changes and stay.
   */
  const discardAllDocuments = useCallback(() => {
    setDraft((prev) => ({ ...prev, redactions: {}, deletes: [] }));
  }, []);

  const setAdditionalData = useCallback((doc: AdditionalDocument | null) => {
    setDraft((prev) => ({ ...prev, additionalData: doc }));
  }, []);

  const addUploads = useCallback((files: File[]) => {
    setUploads((prev) => [...prev, ...files]);
  }, []);

  const removeUpload = useCallback((file: File) => {
    setUploads((prev) => prev.filter((f) => f !== file));
  }, []);

  /** Clear everything after a successful save (or on Discard). */
  const reset = useCallback(() => {
    setDraft(emptyDraft());
    setUploads([]);
    // A "your changes were restored" notice no longer describes anything.
    setRecovered(null);
  }, []);

  const snapshot = useCallback((): SessionSnapshot => ({ ...draft, uploads }), [draft, uploads]);

  const editedFilenames = useMemo(
    () => new Set(Object.keys(draft.redactions).filter((f) => draft.redactions[f].length > 0)),
    [draft.redactions]
  );

  const pendingCount = draftChangeCount(draft) + uploads.length;
  /** Unsaved changes made in the document viewer: one per redaction change, one per removal. */
  const viewerChangeCount =
    Object.values(draft.redactions).reduce((n, list) => n + list.length, 0) + draft.deletes.length;
  const viewerDocumentCount = new Set([...Object.keys(draft.redactions).filter((f) => draft.redactions[f].length > 0), ...draft.deletes]).size;

  return {
    sessionId: draft.sessionId,
    redactions: draft.redactions,
    deletes: draft.deletes,
    additionalData: draft.additionalData,
    uploads,
    editedFilenames,
    pendingCount,
    viewerChangeCount,
    viewerDocumentCount,
    recovered,
    dismissRecovered: () => setRecovered(null),
    setDocumentChanges,
    toggleDelete,
    discardDocument,
    discardAllDocuments,
    setAdditionalData,
    addUploads,
    removeUpload,
    reset,
    snapshot,
  };
}

export type DocumentEditSession = ReturnType<typeof useDocumentEditSession>;
