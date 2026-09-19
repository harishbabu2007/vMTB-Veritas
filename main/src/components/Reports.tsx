import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FileText, AlertTriangle, Loader2, Check, Upload, Plus, Undo2, X, StickyNote } from 'lucide-react';
import { Case } from '../context/CasesContext';
import { Modal } from './Modal';
import { VoiceRecorder } from './VoiceRecorder';
import { DocumentWorkspace, WorkspaceDocument } from './documents/DocumentWorkspace';
import { invalidateRedactionSource } from './documents/useRedactionSource';
import { ReportFile, fetchReportFiles, fetchSignedKeys, toDocumentName } from '../services/redactionService';
import {
  AdditionalDocument,
  SessionSnapshot,
  toRedactionChanges,
  useDocumentEditSession,
} from '../hooks/useDocumentEditSession';
import {
  PipelineError,
  CaseRunState,
  announceCaseChanged,
  commitCaseEdits,
  getTabId,
  CommitInput,
} from '../services/pipelineService';
import { useCaseRunState } from '../hooks/useCaseRunState';
import { useRunActions } from '../hooks/useRunActions';
import { CaseUpdateStatus, SaveProblem } from './CaseUpdateStatus';
import { DismissButton } from './DismissButton';
import { supabase } from '../Supabase/client';
import { loadPdfjs } from '../utils/pdfjs';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';

interface ReportsProps {
  caseData: Case;
  isOwner: boolean;
  // Lets the parent page reflect status changes this tab causes (e.g. a
  // commit moving the case back to processing) without refetching the case.
  onCaseChange?: (patch: Partial<Case>) => void;
  /**
   * Show the documents as they were at this content generation (the owner's
   * last verified version) instead of the current ones. Set for MTB members
   * while a newer version of the case is unverified.
   */
  snapshotGeneration?: number | null;
}

const ANONYMIZED_PREFIX = 'ANO_NNCMFAGSSS_22246_';

// Signed URLs from VMTB-GET-REPORTS expire after 15 minutes and this tab
// stays mounted for the whole page visit, so the listing (used for grid
// thumbnails) is re-fetched before that. Opening a document never relies on
// it — the workspace asks for a fresh URL at open time.
const LIST_REFRESH_MS = 10 * 60 * 1000;

const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'txt'];

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

function documentKind(filename: string): WorkspaceDocument['kind'] {
  const ext = getFileExtension(filename);
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (ext === 'txt') return 'text';
  return 'other';
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Removes the fixed prefix pattern ANO_NNCMFAGSSS_<number>_ from report filenames
 * @param filename - The original filename
 * @returns The filename without the prefix
 */
function stripReportPrefix(filename: string): string {
  // Pattern: ANO_NNCMFAGSSS_<any number>_
  const prefixPattern = /^ANO_NNCMFAGSSS_\d+_/;
  return filename.replace(prefixPattern, '');
}

// ============================================================
// API FUNCTIONS
// ============================================================

async function getUploadConfigForExistingRequest(requestId: string): Promise<{
  uploadUrl: string;
  uploadPrefix: string;
  uploadFields: Record<string, string>;
}> {
  const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-upload-urls_4_new_documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get upload config: ${text}`);
  }

  const data = await response.json();
  return {
    uploadUrl: data.upload.url,
    uploadPrefix: data.upload.prefix,
    uploadFields: data.upload.fields || {},
  };
}

async function uploadFilesToS3(files: File[], uploadUrl: string, uploadPrefix: string, uploadFields: Record<string, string>) {
  const requiredFields = ['x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-security-token', 'policy', 'x-amz-signature'];
  requiredFields.forEach((field) => {
    if (!uploadFields[field]) {
      throw new Error(`Missing upload field: ${field}`);
    }
  });

  for (const file of files) {
    const formData = new FormData();

    // Build key; prefer server-provided template, fallback to prefix
    const keyTemplate = uploadFields.key || `${uploadPrefix}${file.name}`;
    const key = keyTemplate.replace('${filename}', file.name);

    // Append all server-provided fields, replacing filename placeholder where needed
    formData.append('key', key);
    Object.entries(uploadFields).forEach(([field, value]) => {
      if (field === 'key' || field === 'acl') return; // do not send acl unless explicitly required by policy
      const hydrated = value.replace?.('${filename}', file.name) ?? value;
      formData.append(field, hydrated);
    });

    // Add file last
    formData.append('file', file);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Failed to upload ${file.name}: ${text}`);
    }

    console.log('✓ Uploaded to S3:', file.name);
  }
}

export async function fetchAdditionalDocument(caseId: string): Promise<AdditionalDocument | null> {
  const { supabase } = await import('../Supabase/client');
  
  // Don't use .single() - it throws 406 if no rows found
  // Use .maybeSingle() instead, which returns null if no rows
  const { data, error } = await supabase
    .from('case_additional_documents')
    .select('document_title, document_data')
    .eq('case_id', caseId)
    .maybeSingle();
  
  if (error) {
    console.error('Error fetching additional document:', error);
    return null; // Don't throw, just return null
  }
  
  if (!data) {
    return null; // No document found
  }
  
  return {
    title: data.document_title,
    content: data.document_data,
  };
}

// A save that would leave the case with no documents and no notes is held
// for the owner's decision (add data, or archive). If they walk away from
// that decision — close the tab, navigate off, dismiss — the case is archived.
// The pending save is remembered here (localStorage, so it survives the tab
// closing) and applied on the next visit if the keepalive request sent while
// leaving didn't make it.
const emptyArchiveKey = (caseId: string) => `vmtb:empty-case-archive:${caseId}`;

interface PendingEmptyArchive {
  sessionId: string;
  documents: CommitInput['documents'];
  deleteFiles: string[];
  additionalData: AdditionalDocument | null;
}

function readPendingEmptyArchive(caseId: string): PendingEmptyArchive | null {
  try {
    const raw = window.localStorage.getItem(emptyArchiveKey(caseId));
    return raw ? (JSON.parse(raw) as PendingEmptyArchive) : null;
  } catch {
    return null;
  }
}

function writePendingEmptyArchive(caseId: string, pending: PendingEmptyArchive | null) {
  try {
    if (pending) window.localStorage.setItem(emptyArchiveKey(caseId), JSON.stringify(pending));
    else window.localStorage.removeItem(emptyArchiveKey(caseId));
  } catch {
    // Storage unavailable: the in-page dialog still decides; only the
    // "closed the tab" fallback is lost.
  }
}

export function Reports({ caseData, isOwner, onCaseChange, snapshotGeneration = null }: ReportsProps) {
  const isMobile = useIsMobile();

  const [reports, setReports] = useState<ReportFile[]>([]);
  const [loading, setLoading] = useState(false);
  // Refresh with reports already on screen: keep the grid, show a small
  // header indicator instead of the full loading state.
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedReportsRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const [additionalDocument, setAdditionalDocument] = useState<AdditionalDocument | null>(null);
  const [showAdditionalDataModal, setShowAdditionalDataModal] = useState(false);
  const [additionalDataTitle, setAdditionalDataTitle] = useState('');
  const [additionalDataContent, setAdditionalDataContent] = useState('');

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const session = useDocumentEditSession(caseData.id);
  const [workspaceFor, setWorkspaceFor] = useState<string | null>(null);
  // Saving = the commit_case_edits call is in flight (seconds). After it
  // returns, the changes are saved; processing progress comes from runState.
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);
  const [saveProblem, setSaveProblem] = useState<SaveProblem | null>(null);
  // Documents touched by the latest save, for per-document "Updating" chips
  // while that save's run is applying them.
  const [lastSave, setLastSave] = useState<{ runId: string; filenames: string[] } | null>(null);


  // PDF thumbnail cache, keyed by filename.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const thumbnailsRequested = useRef<Set<string>>(new Set());

  const displayedAdditional = session.additionalData ?? additionalDocument;

  // Snapshot mode: document key per listed filename, for re-signing on open.
  const snapshotKeysRef = useRef<Record<string, string>>({});

  /**
   * The documents exactly as they were at generation `g`: those added at or
   * before it and not yet removed then, each at its latest version published
   * at or before it (versions keep immutable per-version files, so a document
   * redacted or removed afterwards still has the content that was verified).
   */
  const loadSnapshotReports = async (g: number) => {
    const requestId = caseData.requestId!;
    const [docsRes, versionsRes, notesRes] = await Promise.all([
      supabase.from('case_documents')
        .select('document_name, file_name, added_generation, deleted_generation, deleted_s3_key, created_at')
        .eq('case_id', caseData.id),
      supabase.from('case_document_versions').select('document_name, version, generation, s3_key').eq('case_id', caseData.id),
      supabase.from('cases').select('verified_snapshot').eq('id', caseData.id).maybeSingle(),
    ]);
    if (docsRes.error) throw docsRes.error;
    if (versionsRes.error) throw versionsRes.error;

    const entries = new Map<string, string>(); // filename -> key
    const docs = [...(docsRes.data || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const d of docs) {
      const liveAtG = (d.added_generation ?? 0) <= g && (d.deleted_generation == null || d.deleted_generation > g);
      if (!liveAtG || !d.document_name) continue;
      const removedSince = d.deleted_generation != null && typeof d.deleted_s3_key === 'string' && d.deleted_s3_key.startsWith('uploads/');
      if (String(d.file_name).toLowerCase().endsWith('.txt')) {
        entries.set(d.file_name, removedSince ? d.deleted_s3_key : `uploads/${requestId}/data/${d.file_name}`);
        continue;
      }
      const best = (versionsRes.data || [])
        .filter((v) => v.document_name === d.document_name && (v.generation ?? 0) <= g)
        .sort((a, b) => b.version - a.version)[0];
      if (!best) continue; // not anonymized yet at that point
      const canonical = `uploads/${requestId}/data/${ANONYMIZED_PREFIX}${d.document_name}.pdf`;
      entries.set(`${ANONYMIZED_PREFIX}${d.document_name}.pdf`, best.s3_key === canonical && removedSince ? d.deleted_s3_key : best.s3_key);
    }

    const urls = await fetchSignedKeys(requestId, [...entries.values()]);
    snapshotKeysRef.current = Object.fromEntries(entries);
    setReports([...entries].filter(([, key]) => urls[key]).map(([filename, key]) => ({ filename, url: urls[key] })));
    const snapshotNotes = notesRes.data?.verified_snapshot?.notes as AdditionalDocument | null | undefined;
    setAdditionalDocument(snapshotNotes && snapshotNotes.content ? snapshotNotes : null);
  };

  const loadReports = useCallback(async () => {
    const status = caseData.reportStatus;
    if (status !== 'unverified' && status !== 'verified' && status !== 'not_ready') return;

    if (!caseData.requestId || caseData.requestId.trim() === '') {
      setError('Reports are not available for this case.');
      return;
    }

    const isBackgroundRefresh = hasLoadedReportsRef.current;
    if (isBackgroundRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError(null);
    }

    try {
      if (snapshotGeneration != null) {
        await loadSnapshotReports(snapshotGeneration);
        hasLoadedReportsRef.current = true;
        setError(null);
        return;
      }
      const [files, removed] = await Promise.all([
        fetchReportFiles(caseData.requestId),
        supabase.from('case_documents').select('document_name, deleted_at').eq('case_id', caseData.id),
      ]);
      if (removed.error) throw removed.error;
      // Removals are committed to the database first; the S3 file is only
      // renamed once processing gets to it. Filter by the database so a
      // removed document never reappears in between.
      // A name removed and later re-added (same file name) is live again.
      const liveNames = new Set((removed.data || []).filter((r) => !r.deleted_at).map((r) => r.document_name as string));
      const removedSet = new Set(
        (removed.data || []).filter((r) => r.deleted_at && !liveNames.has(r.document_name)).map((r) => r.document_name as string)
      );
      setReports(files.filter((f) => !removedSet.has(toDocumentName(f.filename).replace(/\.[^./]+$/, ''))));
      hasLoadedReportsRef.current = true;
      setError(null);

      try {
        const additionalDoc = await fetchAdditionalDocument(caseData.id);
        setAdditionalDocument(additionalDoc);
      } catch (docErr) {
        console.error('Error fetching additional document:', docErr);
      }
    } catch (err) {
      console.error('Error fetching reports:', err);
      if (isBackgroundRefresh) {
        showToast.error("Reports couldn't be refreshed. Showing the last loaded version.");
      } else {
        setError("Reports couldn't be loaded. Try again in a moment.");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseData.id, caseData.reportStatus, caseData.requestId, snapshotGeneration]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && hasLoadedReportsRef.current) loadReports();
    }, LIST_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [loadReports]);

  const forgetThumbnails = useCallback((filenames: Iterable<string>) => {
    const names = new Set(filenames);
    names.forEach((f) => thumbnailsRequested.current.delete(f));
    setThumbnails((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !names.has(k))));
  }, []);

  // ============================================================
  // Saving and processing
  // ============================================================

  const runState = useCaseRunState(isOwner ? caseData.id : undefined, (state: CaseRunState) => {
    onCaseChange?.({
      summaryStatus: state.summary_status,
      reportStatus: (state.report_status as Case['reportStatus']) ?? caseData.reportStatus,
      archivedAt: state.archived_at,
    });
    // Whenever processing moves forward, show the documents as they now are.
    if (hasLoadedReportsRef.current) loadReports();
  });
  const refreshRunState = runState.refresh;
  const runActions = useRunActions(isOwner ? caseData.id : undefined, runState);
  const { start: startRunAndTrack } = runActions;

  // Once a save's document changes are applied, drop cached renders of them.
  const lastRun = runState.state?.run;
  useEffect(() => {
    if (!lastSave || !lastRun || lastRun.id !== lastSave.runId) return;
    if (lastRun.materialize_done || lastRun.status !== 'running') {
      lastSave.filenames.forEach((f) => invalidateRedactionSource(caseData.id, f));
      forgetThumbnails(lastSave.filenames);
    }
  }, [lastRun, lastSave, caseData.id, forgetThumbnails]);

  const updatingFilenames = useMemo(() => {
    const run = runState.state?.run;
    if (!lastSave || !run || run.id !== lastSave.runId) return new Set<string>();
    const applying = (run.status === 'pending' || run.status === 'running') && !run.materialize_done;
    return new Set(applying ? lastSave.filenames : []);
  }, [runState.state, lastSave]);

  /**
   * Save everything in the session: uploads go to storage first, then ONE
   * commit_case_edits call records the whole batch. Only when that returns
   * are the changes saved — nothing is removed or reset before it. Then the
   * run is started; if starting fails the changes are still saved and the
   * strip offers "Start processing".
   */
  const commitSession = useCallback(async (options?: { emptyAction?: 'archive' }) => {
    if (committingRef.current || !caseData.requestId) return;
    const snap: SessionSnapshot = session.snapshot();
    const documents = Object.entries(snap.redactions)
      .filter(([filename, changes]) => changes.length > 0 && !snap.deletes.includes(filename))
      .map(([documentFilename, changes]) => ({ documentFilename, changes: toRedactionChanges(changes) }));
    if (documents.length === 0 && snap.deletes.length === 0 && snap.uploads.length === 0 && !snap.additionalData) return;

    committingRef.current = true;
    setCommitting(true);
    setSaveProblem(null);
    try {
      if (snap.uploads.length > 0) {
        // Same keys every attempt, so a retried save just overwrites them.
        const { uploadUrl, uploadPrefix, uploadFields } = await getUploadConfigForExistingRequest(caseData.requestId);
        await uploadFilesToS3(snap.uploads, uploadUrl, uploadPrefix, uploadFields);
      }

      const run = await commitCaseEdits({
        caseId: caseData.id,
        sessionId: snap.sessionId,
        documents,
        deleteFiles: snap.deletes,
        uploadFiles: snap.uploads.map((f) => ({ file_name: f.name, size: String(f.size), type: f.type || '' })),
        additionalData: snap.additionalData,
        emptyAction: options?.emptyAction ?? null,
      });

      // Saved.
      writePendingEmptyArchive(caseData.id, null);
      setEmptyPrompt(false);
      session.reset();
      if (snap.additionalData) setAdditionalDocument(snap.additionalData);
      setLastSave({ runId: run.id, filenames: [...documents.map((d) => d.documentFilename), ...snap.deletes] });
      announceCaseChanged(caseData.id, getTabId());
      if (run.archived) {
        onCaseChange?.({ archivedAt: new Date().toISOString(), summaryStatus: 'failed' });
        showToast.success('Changes saved. The case had no documents or notes left, so it was archived.');
      } else {
        showToast.success(
          run.duplicate
            ? 'These changes were already saved.'
            : 'Changes saved. The summary will be regenerated and will need your verification.'
        );
      }
      await refreshRunState();
      loadReports();

      await startRunAndTrack(run.id);
    } catch (err) {
      const e = err instanceof PipelineError ? err : null;
      console.error('[Reports] Save failed', err);
      if (e?.code === 'NOTHING_TO_SAVE') {
        session.reset();
        showToast.info(e.message);
      } else if (e?.code === 'CASE_WOULD_BE_EMPTY') {
        // Nothing saved yet: ask what to do, and remember the save so walking
        // away from the question still archives.
        writePendingEmptyArchive(caseData.id, {
          sessionId: snap.sessionId,
          documents,
          deleteFiles: snap.deletes,
          additionalData: snap.additionalData,
        });
        setEmptyPrompt(true);
      } else {
        setSaveProblem({
          message: e?.message ?? (err instanceof Error ? err.message : "Your changes couldn't be saved."),
          // Retrying makes sense unless the user must act first (sign in,
          // fix a name clash, wait for processing).
          canRetry: !e || ['NETWORK', 'UNKNOWN'].includes(e.code),
        });
      }
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }, [caseData.id, caseData.requestId, loadReports, onCaseChange, refreshRunState, session, startRunAndTrack]);

  // ============================================================
  // Emptying the case (no documents, no notes left)
  // ============================================================

  const [emptyPrompt, setEmptyPrompt] = useState(false);
  const accessTokenRef = useRef<string | null>(null);

  const archiveEmptyCase = useCallback(() => {
    commitSession({ emptyAction: 'archive' });
  }, [commitSession]);

  // The owner chose to add data instead: keep their draft, forget the archive.
  const keepCaseAndAddData = useCallback((then: () => void) => {
    writePendingEmptyArchive(caseData.id, null);
    setEmptyPrompt(false);
    then();
  }, [caseData.id]);

  // Walking away while the question is open archives. A keepalive request
  // survives the page unloading; if it doesn't arrive, the stored pending
  // save is applied on the next visit (below).
  useEffect(() => {
    if (!emptyPrompt) return;
    supabase.auth.getSession().then(({ data }) => {
      accessTokenRef.current = data.session?.access_token ?? null;
    });
    const onPageHide = () => {
      const pending = readPendingEmptyArchive(caseData.id);
      const token = accessTokenRef.current;
      if (!pending || !token) return;
      const url = import.meta.env.VITE_SUPABASE_URL as string;
      const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_API) as string;
      fetch(`${url}/rest/v1/rpc/commit_case_edits`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          p_case_id: caseData.id,
          p_session_id: pending.sessionId,
          p_documents: pending.documents.map((d) => ({
            document_filename: d.documentFilename,
            changes: d.changes.map((c) =>
              c.action === 'add'
                ? { action: 'add', page_number: c.pageNumber, bbox: c.bbox, style: c.style }
                : { action: 'remove', redaction_id: c.redactionId }
            ),
          })),
          p_delete_files: pending.deleteFiles,
          p_upload_files: [],
          p_additional_data: pending.additionalData,
          p_empty_action: 'archive',
        }),
      }).catch(() => undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') archiveEmptyCase();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('keydown', onKey);
    };
  }, [emptyPrompt, caseData.id, archiveEmptyCase]);

  // An empty-case decision left unanswered on an earlier visit: archive now.
  const pendingArchiveCheckedRef = useRef(false);
  useEffect(() => {
    if (!isOwner || pendingArchiveCheckedRef.current) return;
    pendingArchiveCheckedRef.current = true;
    const pending = readPendingEmptyArchive(caseData.id);
    if (!pending) return;
    (async () => {
      try {
        const run = await commitCaseEdits({
          caseId: caseData.id,
          sessionId: pending.sessionId,
          documents: pending.documents,
          deleteFiles: pending.deleteFiles,
          uploadFiles: [],
          additionalData: pending.additionalData,
          emptyAction: 'archive',
        });
        writePendingEmptyArchive(caseData.id, null);
        session.reset();
        if (run.archived) onCaseChange?.({ archivedAt: new Date().toISOString(), summaryStatus: 'failed' });
        if (!run.duplicate) {
          showToast.info('You left this case with no documents or notes, so it was archived.');
          await startRunAndTrack(run.id);
        }
        refreshRunState();
        loadReports();
      } catch (err) {
        // The case changed since (e.g. data was added): nothing to archive.
        console.warn('[Reports] Pending empty-case archive not applied', err);
        writePendingEmptyArchive(caseData.id, null);
      }
    })();
  }, [isOwner, caseData.id, loadReports, onCaseChange, refreshRunState, session, startRunAndTrack]);

  // Leaving or reloading the page with unsaved changes (or mid-save) asks first.
  useEffect(() => {
    if (!isOwner || (session.pendingCount === 0 && !committing)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isOwner, session.pendingCount, committing]);

  const saveAndCloseWorkspace = useCallback(() => {
    setWorkspaceFor(null);
    commitSession();
  }, [commitSession]);

  // ============================================================
  // Uploads and "your data"
  // ============================================================

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validFiles: File[] = [];
    const rejectedFiles: string[] = [];
    const blockedPdfs: string[] = [];
    const takenNames = new Set([...reports.map((r) => stripReportPrefix(r.filename)), ...session.uploads.map((f) => f.name)]);

    for (const file of Array.from(files)) {
      const extension = getFileExtension(file.name);
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejectedFiles.push(`${file.name} (allowed types: ${ALLOWED_EXTENSIONS.join(', ')})`);
        continue;
      }
      if (takenNames.has(file.name)) {
        rejectedFiles.push(`${file.name} (a document with this name already exists)`);
        continue;
      }
      if (extension === 'pdf') {
        try {
          const pdfjsLib = await loadPdfjs();
          const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
          if (pdf.numPages > 50) {
            blockedPdfs.push(`"${file.name}" (${pdf.numPages} pages)`);
            continue;
          }
        } catch (err) {
          console.warn('Could not validate PDF page count for:', file.name, err);
        }
      }
      validFiles.push(file);
    }

    if (blockedPdfs.length > 0) {
      showToast.error(`PDFs can have at most 50 pages: ${blockedPdfs.join(', ')}`);
    }
    if (rejectedFiles.length > 0) {
      showToast.error(`Not added: ${rejectedFiles.join(', ')}.`);
    }
    if (validFiles.length > 0) {
      setUploadingFiles(validFiles);
      setShowUploadModal(true);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleConfirmUpload = () => {
    session.addUploads(uploadingFiles);
    setUploadingFiles([]);
    setShowUploadModal(false);
  };

  const openAdditionalData = () => {
    setAdditionalDataTitle(displayedAdditional?.title || 'Additional Data');
    setAdditionalDataContent(displayedAdditional?.content || '');
    setShowAdditionalDataModal(true);
  };

  const handleSaveAdditionalData = () => {
    const next = { title: additionalDataTitle || 'Additional Data', content: additionalDataContent };
    const saved = additionalDocument;
    // Unchanged from what's saved: nothing to save (and no re-verification).
    if (saved && saved.title === next.title && saved.content === next.content) {
      session.setAdditionalData(null);
    } else {
      session.setAdditionalData(next);
    }
    setShowAdditionalDataModal(false);
  };

  // ============================================================
  // Thumbnails
  // ============================================================

  useEffect(() => {
    const pdfReports = reports.filter(
      (r) => documentKind(r.filename) === 'pdf' && !thumbnailsRequested.current.has(r.filename)
    );
    if (pdfReports.length === 0) return;
    let cancelled = false;

    (async () => {
      const pdfjsLib = await loadPdfjs();
      for (const report of pdfReports) {
        if (cancelled) break;
        thumbnailsRequested.current.add(report.filename);
        try {
          const resp = await fetch(report.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const pdf = await pdfjsLib.getDocument({ data: await resp.arrayBuffer() }).promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 0.8 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({ canvas, canvasContext: ctx, viewport }).promise;
            if (!cancelled) setThumbnails((prev) => ({ ...prev, [report.filename]: canvas.toDataURL('image/jpeg', 0.8) }));
          }
          pdf.destroy();
        } catch {
          // Allow a retry after the next listing refresh (e.g. an expired URL).
          thumbnailsRequested.current.delete(report.filename);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reports]);

  // ============================================================
  // Render
  // ============================================================

  const workspaceDocuments = useMemo<WorkspaceDocument[]>(
    () => [
      ...reports.map((r) => ({
        filename: r.filename,
        displayName: stripReportPrefix(r.filename),
        kind: documentKind(r.filename),
        thumbnail: thumbnails[r.filename] ?? (documentKind(r.filename) === 'image' ? r.url : undefined),
        getUrl:
          snapshotGeneration != null && caseData.requestId && snapshotKeysRef.current[r.filename]
            ? async () => {
                const key = snapshotKeysRef.current[r.filename];
                const urls = await fetchSignedKeys(caseData.requestId!, [key]);
                if (!urls[key]) throw new Error('This version of the document is no longer available.');
                return urls[key];
              }
            : undefined,
      })),
      ...session.uploads.map((file) => ({
        filename: `pending:${file.name}`,
        displayName: file.name,
        kind: documentKind(file.name),
        file,
      })),
    ],
    [reports, thumbnails, session.uploads, snapshotGeneration, caseData.requestId]
  );

  const isProcessing = caseData.reportStatus === 'not_ready';
  const hasCachedReports = reports.length > 0;
  const showBlockingProcessing = isProcessing && !hasCachedReports;

  const statusLine = (filename: string, pending: boolean) => {
    if (pending) return { text: 'Added, not uploaded yet', className: 'text-amber-700' };
    if (session.deletes.includes(filename)) return { text: 'Will be removed', className: 'text-red-600' };
    if (updatingFilenames.has(filename)) return { text: 'Updating…', className: 'text-text-muted' };
    if (session.editedFilenames.has(filename)) return { text: 'Edited', className: 'text-green-700' };
    return {
      text: caseData.createdDate
        ? new Date(caseData.createdDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Report',
      className: 'text-gray-400',
    };
  };

  return (
    <div className="w-full flex flex-col gap-4">
      {isOwner && session.recovered && (
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 rounded-lg border border-blue-200 bg-blue-50 text-sm text-blue-900" role="status">
          <p>
            {session.recovered === 'restored'
              ? 'Your unsaved changes were restored. They are not saved yet.'
              : 'Your last changes were already saved.'}
          </p>
          <DismissButton onClick={session.dismissRecovered} label="Dismiss this notice" />
        </div>
      )}

      {showBlockingProcessing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <Loader2 className="w-8 h-8 text-blue-600 mx-auto mb-3 animate-spin" />
          <p className="text-sm text-blue-800 font-medium">
            Documents are being anonymized. They'll appear here shortly.
          </p>
        </div>
      )}

      {error && !showBlockingProcessing && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
          <AlertTriangle className="w-6 h-6 text-red-600 mx-auto mb-2" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading && !showBlockingProcessing && (
        <div className="bg-surface rounded-xl shadow-sm border border-border p-8 text-center">
          <Loader2 className="w-8 h-8 text-blue-600 mx-auto mb-3 animate-spin" />
          <p className="text-sm text-text-muted">Loading reports…</p>
        </div>
      )}

      {!showBlockingProcessing && !loading && !error && (
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <h2 className={`font-bold text-text ${isMobile ? 'text-lg' : 'text-xl'}`}>
                All Reports
              </h2>
              {isProcessing && hasCachedReports && (
                <span className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Reprocessing documents…
                </span>
              )}
              {refreshing && !(isProcessing && hasCachedReports) && (
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Updating…
                </span>
              )}
            </div>
            {isOwner && (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={committing}
                data-tour="reports-add"
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg text-text-muted bg-surface border border-border hover:bg-bg transition-colors disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                <span>Add documents</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept=".png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.pdf,.txt"
            />
          </div>

          {isOwner && workspaceFor === null && (
            <CaseUpdateStatus
              caseId={caseData.id}
              runState={runState.state}
              isOwner={isOwner}
              unsavedCount={session.pendingCount}
              saving={committing}
              saveProblem={saveProblem}
              startFailed={runActions.startFailed}
              busy={committing || runActions.retrying}
              onSave={() => commitSession()}
              onDiscard={() => { session.reset(); setSaveProblem(null); }}
              onRetrySave={() => commitSession()}
              onStartRun={runActions.startCurrentRun}
              onRetryRun={runActions.retryFailedRun}
            />
          )}
          {isOwner && runState.changedElsewhere && (
            <div className="flex items-center justify-between gap-3 px-4 py-2 rounded-lg border border-border bg-surface text-sm" role="status">
              <span className="text-text-muted">This case was changed in another tab.</span>
              <div className="flex items-center gap-3">
                <button onClick={() => { runState.dismissChangedElsewhere(); loadReports(); }} className="font-medium text-primary">
                  Show latest
                </button>
                <DismissButton onClick={runState.dismissChangedElsewhere} label="Dismiss this notice" className="text-text-muted" />
              </div>
            </div>
          )}

          {/* Grid: as many columns as fit, not a fixed count. */}
          {workspaceDocuments.length > 0 || displayedAdditional || isOwner ? (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 140 : 180}px, 1fr))` }}
            >
              {displayedAdditional ? (
                <button
                  type="button"
                  className="group text-left rounded-xl border-2 border-border hover:border-blue-300 hover:shadow-lg transition-all bg-surface overflow-hidden"
                  onClick={openAdditionalData}
                >
                  <div className="aspect-[4/3] bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center">
                    <StickyNote className={`${isMobile ? 'w-7 h-7' : 'w-10 h-10'} text-green-400`} />
                  </div>
                  <div className="px-3 py-2 border-t border-border">
                    <p className={`font-medium text-text truncate ${isMobile ? 'text-xs' : 'text-sm leading-tight'}`}>{displayedAdditional.title}</p>
                    <p className={`mt-0.5 ${isMobile ? 'text-[10px]' : 'text-xs'} ${session.additionalData ? 'text-amber-700' : 'text-gray-400'}`}>
                      {session.additionalData ? 'Edited, not saved yet' : 'Your data'}
                    </p>
                  </div>
                </button>
              ) : null}

              {workspaceDocuments.map((doc, docIndex) => {
                const pending = Boolean(doc.file);
                const deleted = session.deletes.includes(doc.filename);
                const updating = updatingFilenames.has(doc.filename);
                const status = statusLine(doc.filename, pending);
                return (
                  <div
                    key={doc.filename}
                    data-tour={docIndex === 0 ? 'report-card' : undefined}
                    className={`group relative rounded-xl border-2 transition-all overflow-hidden ${
                      deleted ? 'border-dashed border-red-300 bg-red-50/40' : 'border-border hover:border-blue-300 hover:shadow-lg bg-surface'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setWorkspaceFor(doc.filename)}
                      className="block w-full text-left"
                      aria-label={`Open ${doc.displayName}`}
                    >
                      <div className={`aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden relative ${deleted ? 'opacity-50' : ''}`}>
                        {doc.thumbnail ? (
                          <img
                            src={doc.thumbnail}
                            alt=""
                            className={`w-full h-full ${doc.kind === 'image' ? 'object-cover' : 'object-contain bg-surface p-1'}`}
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex flex-col items-center justify-center gap-1">
                            <FileText className={`${isMobile ? 'w-7 h-7' : 'w-10 h-10'} ${doc.kind === 'pdf' ? 'text-red-300' : 'text-gray-300'}`} />
                            <span className="text-[10px] text-gray-400 uppercase">{getFileExtension(doc.displayName)}</span>
                          </div>
                        )}
                        {updating && (
                          <div className="absolute inset-0 bg-surface/70 flex items-center justify-center gap-1.5">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            <span className="text-xs font-medium text-text-muted">Updating…</span>
                          </div>
                        )}
                        {session.editedFilenames.has(doc.filename) && !deleted && !updating && (
                          <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-green-600 text-white flex items-center justify-center shadow" aria-hidden="true">
                            <Check className="w-3 h-3" />
                          </span>
                        )}
                      </div>
                      <div className={`px-3 py-2 border-t border-border ${isOwner && (pending || deleted) ? 'pr-12' : ''}`}>
                        <p className={`font-medium truncate ${deleted ? 'text-red-400 line-through' : 'text-text'} ${isMobile ? 'text-xs' : 'text-sm leading-tight'}`}>
                          {doc.displayName}
                        </p>
                        <p className={`mt-0.5 ${isMobile ? 'text-[10px]' : 'text-xs'} ${status.className}`}>{status.text}</p>
                      </div>
                    </button>

                    {isOwner && pending && (
                      <button
                        onClick={() => session.removeUpload(doc.file!)}
                        className="absolute bottom-2.5 right-2.5 p-1.5 rounded-full bg-surface shadow border border-border hover:bg-bg"
                        aria-label={`Don't add ${doc.displayName}`}
                        title="Don't add this file"
                      >
                        <X className="w-3.5 h-3.5 text-text-muted" />
                      </button>
                    )}
                    {isOwner && deleted && (
                      <button
                        onClick={() => session.toggleDelete(doc.filename)}
                        className="absolute bottom-2.5 right-2.5 flex items-center gap-1 px-2 py-1 rounded-full bg-surface shadow border border-red-200 hover:bg-red-50 text-xs font-medium text-red-600"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                        Keep
                      </button>
                    )}
                  </div>
                );
              })}

              {isOwner && !displayedAdditional && (
                <button
                  type="button"
                  onClick={openAdditionalData}
                  className="rounded-xl border-2 border-dashed border-border text-text-muted hover:border-green-400 hover:text-green-700 hover:bg-green-50/50 transition-colors flex flex-col items-center justify-center gap-2 min-h-[140px]"
                >
                  <Plus className="w-6 h-6" />
                  <span className="text-sm font-medium">Add your data</span>
                </button>
              )}
            </div>
          ) : (
            <div className="bg-surface rounded-xl shadow-sm border border-border p-8 text-center">
              <FileText className={`text-gray-200 mx-auto mb-4 ${isMobile ? 'w-12 h-12' : 'w-16 h-16'}`} />
              <p className="text-text-muted font-medium">No reports available for this case.</p>
            </div>
          )}
        </div>
      )}

      {workspaceFor !== null && caseData.requestId && (
        <DocumentWorkspace
          documents={workspaceDocuments}
          initialFilename={workspaceFor}
          requestId={caseData.requestId}
          caseId={caseData.id}
          isOwner={isOwner}
          session={session}
          updatingFilenames={updatingFilenames}
          onSaveAndClose={saveAndCloseWorkspace}
          onClose={() => setWorkspaceFor(null)}
        />
      )}

      {emptyPrompt && (
        <div className="fixed inset-0 z-[120000] flex items-center justify-center px-4" role="alertdialog" aria-modal="true" aria-labelledby="empty-case-title">
          {/* Dismissing the question archives, as agreed: walking away from an empty case archives it. */}
          <div className="absolute inset-0 bg-gray-900/40" onClick={archiveEmptyCase} aria-hidden="true" />
          <div className="relative w-full max-w-md rounded-xl bg-surface shadow-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <h3 id="empty-case-title" className="text-base font-semibold text-text-muted">
                This case would have no documents or notes
              </h3>
              <button onClick={archiveEmptyCase} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="Close and archive the case">
                <X className="w-4 h-4 text-text-muted" />
              </button>
            </div>
            <p className="mt-2 text-sm text-text-muted">
              A case needs at least one document or note to summarize. Add something to keep working on it, or archive it.
              If you close this or leave the page, the case is archived.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                onClick={() => keepCaseAndAddData(() => fileInputRef.current?.click())}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-text hover:bg-bg"
              >
                Add documents
              </button>
              <button
                onClick={() => keepCaseAndAddData(openAdditionalData)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-text hover:bg-bg"
              >
                Add your data
              </button>
              <button
                onClick={archiveEmptyCase}
                disabled={committing}
                className="px-4 py-2 text-sm font-medium rounded-lg text-white bg-gray-800 hover:bg-gray-900 disabled:opacity-50"
              >
                {committing ? 'Archiving…' : 'Archive case'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <Modal isOpen={showUploadModal} onClose={() => setShowUploadModal(false)} title="Add documents">
          <div className="space-y-4">
            <ul className="text-sm text-text space-y-1 max-h-60 overflow-y-auto">
              {uploadingFiles.map((file, idx) => (
                <li key={idx} className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="flex-1 truncate">{file.name}</span>
                  <span className="text-text-muted text-xs">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-text-muted">
              They'll be uploaded and processed when you save your changes.
            </p>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setUploadingFiles([]);
                }}
                className="px-4 py-2 border border-border rounded-lg text-text hover:bg-bg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmUpload}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2 bg-primary"
              >
                <Plus className="w-4 h-4" />
                <span>Add {uploadingFiles.length === 1 ? 'document' : `${uploadingFiles.length} documents`}</span>
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showAdditionalDataModal && (
        <Modal
          isOpen={showAdditionalDataModal}
          onClose={() => setShowAdditionalDataModal(false)}
          title={isOwner ? (displayedAdditional ? 'Edit your data' : 'Add your data') : displayedAdditional?.title || 'Your data'}
          size="large"
        >
          {isOwner ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="additional-title" className="block text-sm font-medium text-text mb-1">Title</label>
                <input
                  id="additional-title"
                  type="text"
                  value={additionalDataTitle}
                  onChange={(e) => setAdditionalDataTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="additional-content" className="block text-sm font-medium text-text">Content</label>
                  {/* VoiceRecorder's own idle icon is a bare 14px glyph with no
                      background — easy to miss next to a full-width textarea.
                      This chip (padding/border/larger icon) wraps it without
                      touching the shared "do not touch" component; the border
                      also still frames its recording/transcribing states.
                      The chip forwards clicks anywhere on it (including the
                      "Dictate" label) to VoiceRecorder's own mic button, so
                      the whole chip is clickable, not just the icon glyph. */}
                  <div
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-border hover:border-primary hover:bg-status-processing-bg transition-colors cursor-pointer"
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      const micButton = e.currentTarget.querySelector('.voice-recorder-mic-btn') as HTMLButtonElement | null;
                      if (micButton && !micButton.contains(target)) micButton.click();
                    }}
                  >
                    <VoiceRecorder
                      onTranscriptionComplete={(text) =>
                        setAdditionalDataContent((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${text}` : text))
                      }
                      variant="inline"
                      source="step2"
                      iconSize={20}
                    />
                    <span className="text-xs font-medium text-text-muted">Dictate</span>
                  </div>
                </div>
                <textarea
                  id="additional-content"
                  value={additionalDataContent}
                  onChange={(e) => setAdditionalDataContent(e.target.value)}
                  rows={20}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                />
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowAdditionalDataModal(false)}
                  className="px-4 py-2 border border-border rounded-lg text-text hover:bg-bg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveAdditionalData}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2 bg-primary"
                >
                  <Check className="w-4 h-4" />
                  <span>Save</span>
                </button>
              </div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap text-text text-sm leading-relaxed">{displayedAdditional?.content}</pre>
          )}
        </Modal>
      )}
    </div>
  );
}
