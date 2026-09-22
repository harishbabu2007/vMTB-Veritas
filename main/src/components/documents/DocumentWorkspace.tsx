import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, EyeOff, FileText, Loader2, Minus, PenTool, Plus, Redo2, Square, Trash2, Undo2, X,
} from 'lucide-react';
import type { OriginalPage, RedactionRecord, RedactionStyle } from '../../services/redactionService';
import { fetchFreshReportUrl } from '../../services/redactionService';
import type { DocumentEditSession, LocalChange } from '../../hooks/useDocumentEditSession';
import { fetchDocumentBytes } from '../../utils/pdfjs';
import { useIsMobile } from '../../hooks/useMobile';
import { useTourGroup } from '../../hooks/useTourGroup';
import { PdfPages, PdfSource } from './PdfPages';
import { PageThumbnailRail } from './PageThumbnailRail';
import { RedactionCanvas, RedactionTool } from './RedactionCanvas';
import { REGION_COLORS, styleFill } from './redactionStyles';
import { useRedactionSource } from './useRedactionSource';
import { DocumentError, DocumentLoading } from './DocumentStatus';
import { RegionSnippet } from './RegionSnippet';

export interface WorkspaceDocument {
  /** Exact filename from VMTB-GET-REPORTS, or the local name of a pending upload. */
  filename: string;
  displayName: string;
  kind: 'pdf' | 'image' | 'text' | 'other';
  /** Set for uploads that haven't been committed yet. */
  file?: File;
  /**
   * How to get a freshly signed URL when this isn't the document's current
   * file (e.g. an MTB member viewing the last verified version).
   */
  getUrl?: () => Promise<string>;
  thumbnail?: string;
}

interface DocumentWorkspaceProps {
  documents: WorkspaceDocument[];
  initialFilename: string;
  requestId: string;
  caseId: string;
  isOwner: boolean;
  session: DocumentEditSession;
  /** Documents whose last save is still being applied on the backend (shown, not blocked). */
  updatingFilenames: Set<string>;
  /** Close and apply every unsaved viewer change (one commit). */
  onSaveAndClose: () => void;
  /** Close without applying. Called only after the viewer's changes were discarded. */
  onClose: () => void;
}

type Mode = 'view' | 'redact';
type Zoom = 'width' | 'page' | number;

const PRIMARY = 'var(--color-primary-solid)';
const INK = 'var(--color-text-muted)';
const CANVAS_BG = 'var(--color-bg)';
const MAX_FIT_WIDTH = 1000;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const A4_ASPECT = 1.414;

const STYLE_OPTIONS: { value: RedactionStyle; label: string }[] = [
  { value: 'whiteout', label: 'White' },
  { value: 'blackout', label: 'Black' },
  { value: 'blur', label: 'Blur' },
];

function humanizeCategory(region: RedactionRecord) {
  if (region.source === 'manual') return 'Added by you';
  if (!region.category) return region.source === 'automated_visual' ? 'Detected automatically (image)' : 'Detected automatically';
  const text = region.category.replace(/[_-]+/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Full-screen workspace for reading a case's documents and, for the owner,
 * redacting them. One surface replaces the old viewer overlay plus the
 * separate redaction editor, so editing starts from the document you're
 * already looking at and moving on to the next document never closes
 * anything.
 *
 * Nothing here talks to the backend on edit: every change goes straight into
 * the shared edit session and is visible immediately (the document reads as
 * saved, and View shows the redacted result). Reports commits the whole
 * session once, when this workspace closes.
 */
export function DocumentWorkspace({
  documents, initialFilename, requestId, caseId, isOwner, session, updatingFilenames, onSaveAndClose, onClose,
}: DocumentWorkspaceProps) {
  const isMobile = useIsMobile();
  const [activeFilename, setActiveFilename] = useState(initialFilename);
  const [mode, setMode] = useState<Mode>('view');
  const [zoom, setZoom] = useState<Zoom>('width');
  const [page, setPage] = useState({ current: 1, total: 0 });
  const [tool, setTool] = useState<RedactionTool>('box');
  const [style, setStyle] = useState<RedactionStyle>('whiteout');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [redoStacks, setRedoStacks] = useState<Record<string, LocalChange[]>>({});
  const [discardMenuOpen, setDiscardMenuOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [redactionsDrawerOpen, setRedactionsDrawerOpen] = useState(false);
  const lastAutoRefreshRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const activeIndex = Math.max(0, documents.findIndex((d) => d.filename === activeFilename));
  const doc = documents[activeIndex];
  const changes = useMemo(() => session.redactions[doc?.filename ?? ''] ?? [], [session.redactions, doc?.filename]);
  const isDeleted = Boolean(doc && session.deletes.includes(doc.filename));
  const isUpdating = Boolean(doc && updatingFilenames.has(doc.filename));
  const canRedact = Boolean(isOwner && doc && doc.kind === 'pdf' && !doc.file && !isDeleted);
  // The owner can switch to Redact at any moment, so start loading the
  // originals as soon as a PDF opens rather than on the click; others only
  // need them to preview edits (which they can't make).
  const showRedactionSource = Boolean(doc && doc.kind === 'pdf' && !doc.file && (isOwner || changes.length > 0));
  const hasViewerChanges = session.viewerChangeCount > 0;

  const redaction = useRedactionSource(requestId, caseId, doc?.filename ?? null, showRedactionSource);
  const { refresh: refreshRedaction } = redaction;
  const hiddenCount = redaction.source
    ? redaction.source.regions.length
      - changes.filter((c) => c.action === 'remove').length
      + changes.filter((c) => c.action === 'add').length
    : 0;
  // Walkthrough tips: the View/Redact switch the first time the owner opens
  // an editable document, then the tools the first time they redact.
  const redactReady = mode === 'redact' && Boolean(redaction.source) && !redaction.unavailable;
  useTourGroup('document_viewer', canRedact && mode === 'view');
  useTourGroup('redact', redactReady);

  // A page image that fails to load almost always has an expired signed URL:
  // re-sign once, but not in a loop if the page is genuinely unavailable.
  const handlePageImageError = useCallback(() => {
    if (Date.now() - lastAutoRefreshRef.current < 30000) return false;
    lastAutoRefreshRef.current = Date.now();
    refreshRedaction();
    return true;
  }, [refreshRedaction]);

  const requestBack = useCallback(() => {
    setDiscardMenuOpen(false);
    if (hasViewerChanges) setConfirmLeave(true);
    else onClose();
  }, [hasViewerChanges, onClose]);

  const discardAndLeave = () => {
    session.discardAllDocuments();
    setConfirmLeave(false);
    onClose();
  };

  // The document column's size drives page width: fit-to-width by default,
  // capped so pages stay readable on very wide screens.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitWidth = Math.max(0, Math.min(viewport.width - (isMobile ? 16 : 48), MAX_FIT_WIDTH));
  const pageWidth = Math.round(
    zoom === 'width' ? fitWidth : zoom === 'page' ? Math.min(fitWidth, (viewport.height - 32) / A4_ASPECT) : fitWidth * zoom
  );
  const numericZoom = typeof zoom === 'number' ? zoom : 1;

  const selectDocument = useCallback((filename: string) => {
    setActiveFilename(filename);
    setPage({ current: 1, total: 0 });
    setHoveredId(null);
    setRedactionsDrawerOpen(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    if (!canRedact && mode === 'redact') setMode('view');
  }, [canRedact, mode]);

  useEffect(() => {
    if (mode !== 'redact') setRedactionsDrawerOpen(false);
  }, [mode]);

  // Shared by the page rail and the redactions drawer's per-region "Page N"
  // links: both PdfPages and RedactionCanvas mark each page's mounted
  // element with the same 0-indexed data-page-index (see LazyPage).
  const scrollToPageIndex = useCallback((index: number) => {
    scrollRef.current
      ?.querySelector(`[data-page-index="${index}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const setChanges = useCallback(
    (next: LocalChange[]) => {
      if (!doc) return;
      session.setDocumentChanges(doc.filename, next);
      setRedoStacks((prev) => ({ ...prev, [doc.filename]: [] }));
    },
    [doc, session]
  );

  const undo = useCallback(() => {
    if (!doc || changes.length === 0) return;
    const last = changes[changes.length - 1];
    session.setDocumentChanges(doc.filename, changes.slice(0, -1));
    setRedoStacks((prev) => ({ ...prev, [doc.filename]: [...(prev[doc.filename] ?? []), last] }));
  }, [doc, changes, session]);

  const redoStack = useMemo(() => redoStacks[doc?.filename ?? ''] ?? [], [redoStacks, doc?.filename]);
  const redo = useCallback(() => {
    if (!doc || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    session.setDocumentChanges(doc.filename, [...changes, next]);
    setRedoStacks((prev) => ({ ...prev, [doc.filename]: redoStack.slice(0, -1) }));
  }, [doc, changes, redoStack, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmLeave) setConfirmLeave(false);
        else if (discardMenuOpen) setDiscardMenuOpen(false);
        else requestBack();
      } else if (mode === 'redact' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, confirmLeave, discardMenuOpen, requestBack, undo, redo]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const handlePageInfo = useCallback((current: number, total: number) => setPage({ current, total }), []);

  const pdfSource = useMemo<PdfSource | null>(() => {
    if (!doc || doc.kind !== 'pdf') return null;
    return doc.file
      ? { kind: 'file', key: `file:${doc.filename}`, file: doc.file }
      : { kind: 'url', key: `url:${doc.filename}`, getUrl: doc.getUrl ?? (() => fetchFreshReportUrl(requestId, doc.filename)) };
  }, [doc, requestId]);

  const stepZoom = (direction: 1 | -1) => {
    const index = ZOOM_STEPS.findIndex((z) => z >= numericZoom - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (index === -1 ? 2 : index) + direction))];
    setZoom(next === 1 ? 'width' : next);
  };

  if (!doc) return null;

  const renderDocument = () => {
    if (mode === 'redact') {
      // Editing while an earlier save of this document is still being
      // applied is fine: the canvas draws the retained originals plus the
      // redactions already saved in the database, never the file being
      // regenerated, and saving again supersedes that run.
      if (redaction.error) return <DocumentError message={redaction.error} onRetry={redaction.retry} />;
      if (!redaction.source) return <DocumentLoading label="Preparing document for redaction…" />;
      if (redaction.unavailable) {
        return (
          <DocumentError message="Redaction isn't available for this document. Its 30-day editing window has closed, or it was processed before editing existed." />
        );
      }
      return (
        <RedactionCanvas
          source={redaction.source}
          interactive
          changes={changes}
          onChange={setChanges}
          tool={tool}
          style={style}
          width={pageWidth}
          hoveredId={hoveredId}
          onHover={setHoveredId}
          onPageInfo={handlePageInfo}
          onPageImageError={handlePageImageError}
        />
      );
    }

    // View: an edited document shows its result, not the stale file on the server.
    if (changes.length > 0 && showRedactionSource) {
      if (redaction.error) return <DocumentError message={redaction.error} onRetry={redaction.retry} />;
      if (!redaction.source) return <DocumentLoading />;
      if (!redaction.unavailable) {
        return (
          <RedactionCanvas
            source={redaction.source}
            interactive={false}
            changes={changes}
            onChange={setChanges}
            tool={tool}
            style={style}
            width={pageWidth}
            hoveredId={null}
            onHover={setHoveredId}
            onPageInfo={handlePageInfo}
            onPageImageError={handlePageImageError}
          />
        );
      }
    }
    if (pdfSource) return <PdfPages source={pdfSource} width={pageWidth} onPageInfo={handlePageInfo} />;
    if (doc.kind === 'image') return <ImageDocument doc={doc} requestId={requestId} width={pageWidth} />;
    if (doc.kind === 'text') return <TextDocument doc={doc} requestId={requestId} width={pageWidth} />;
    return (
      <DocumentError
        message={doc.file ? 'A preview of this file will be available once your changes are applied and it has been processed.' : "This file type can't be previewed."}
      />
    );
  };

  const workspace = (
    // A tour host: its walkthrough tips show over it (see TourOverlay).
    <div className="fixed inset-0 z-[110000] flex flex-col bg-surface" role="dialog" aria-modal="true" aria-label={doc.displayName} data-tour-host>
      {/* Top bar */}
      <header className="h-12 flex-shrink-0 flex items-center gap-2 sm:gap-3 px-2 sm:px-4 border-b border-border bg-surface">
        <button
          onClick={requestBack}
          className="flex items-center gap-1.5 px-2 py-1.5 text-sm font-medium rounded-lg hover:bg-surface-muted transition-colors"
          style={{ color: INK }}
          aria-label="Back to reports"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          {!isMobile && 'Back'}
        </button>
        <span className="w-px h-6 bg-border" aria-hidden="true" />
        {isMobile && documents.length > 1 && (
          <button
            onClick={() => selectDocument(documents[(activeIndex - 1 + documents.length) % documents.length].filename)}
            className="p-2 rounded-lg hover:bg-surface-muted"
            aria-label="Previous document"
          >
            <ChevronLeft className="w-4 h-4" style={{ color: INK }} />
          </button>
        )}
        <div className="min-w-0 flex items-center gap-2 flex-1">
          <h2 className="text-sm font-semibold truncate" style={{ color: INK }} title={doc.displayName}>
            {doc.displayName}
          </h2>
          <DocumentStateChip edited={changes.length > 0} deleted={isDeleted} updating={isUpdating} />
          {/* Mobile has no room for the page thumbnail rail; this read-only
              position readout is the "lighter" equivalent, next to the
              document prev/next chevrons which already cover documents. */}
          {isMobile && page.total > 1 && (
            <span className="flex-shrink-0 text-xs tabular-nums text-text-muted" aria-live="polite">
              p.{page.current}/{page.total}
            </span>
          )}
        </div>

        {isMobile && documents.length > 1 && (
          <button
            onClick={() => selectDocument(documents[(activeIndex + 1) % documents.length].filename)}
            className="p-2 rounded-lg hover:bg-surface-muted"
            aria-label="Next document"
          >
            <ChevronRight className="w-4 h-4" style={{ color: INK }} />
          </button>
        )}

        {canRedact && (
          <div data-tour="viewer-mode" className="flex items-center p-0.5 rounded-lg bg-bg" role="tablist" aria-label="Mode">
            {(['view', 'redact'] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  mode === m ? 'bg-surface text-primary shadow-sm ring-1 ring-border' : 'text-text-muted hover:text-text'
                }`}
              >
                {m === 'view' ? 'View' : 'Redact'}
              </button>
            ))}
          </div>
        )}

        {mode === 'redact' && !isMobile && redaction.source && !redaction.unavailable && (
          <button
            data-tour="redact-panel"
            onClick={() => setRedactionsDrawerOpen((o) => !o)}
            aria-haspopup="true"
            aria-expanded={redactionsDrawerOpen}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
              redactionsDrawerOpen ? 'border-primary text-primary bg-status-processing-bg' : 'border-border text-text-muted hover:bg-bg'
            }`}
          >
            <EyeOff className="w-4 h-4" aria-hidden="true" />
            Redactions
            <span className="tabular-nums">{hiddenCount}</span>
          </button>
        )}

        {!isMobile && (
          <div className="flex items-center gap-1 text-sm" style={{ color: INK }}>
            {page.total > 0 && (
              <span className="px-2 tabular-nums text-text-muted" aria-live="polite">
                {page.current} / {page.total}
              </span>
            )}
            <button onClick={() => stepZoom(-1)} className="p-1.5 rounded-lg hover:bg-surface-muted" aria-label="Zoom out">
              <Minus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setZoom(zoom === 'width' ? 'page' : 'width')}
              className="px-2 py-1 rounded-lg hover:bg-surface-muted min-w-[5.5rem] text-center"
              title="Switch between fitting the page width and the whole page"
            >
              {zoom === 'width' ? 'Fit width' : zoom === 'page' ? 'Fit page' : `${Math.round(numericZoom * 100)}%`}
            </button>
            <button onClick={() => stepZoom(1)} className="p-1.5 rounded-lg hover:bg-surface-muted" aria-label="Zoom in">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {isOwner && !isMobile && (
          <button
            onClick={() => {
              if (doc.file) {
                // Not uploaded yet: just take it out of the draft.
                const next = documents.find((d) => d.filename !== doc.filename);
                session.removeUpload(doc.file);
                if (next) selectDocument(next.filename);
                else onClose();
              } else {
                session.toggleDelete(doc.filename);
              }
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              isDeleted ? 'text-danger bg-danger-bg hover:bg-danger-bg-strong' : 'text-text-muted hover:text-danger hover:bg-danger-bg'
            }`}
            aria-pressed={isDeleted}
          >
            {isDeleted ? <Undo2 className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
            {isDeleted ? 'Keep document' : 'Remove'}
          </button>
        )}

        {hasViewerChanges && (
          <div className="relative">
            <button
              onClick={() => setDiscardMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={discardMenuOpen}
              className="flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium rounded-lg border border-border text-text-muted hover:bg-bg transition-colors"
            >
              Discard
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </button>
            {discardMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setDiscardMenuOpen(false)} aria-hidden="true" />
                <div role="menu" className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg bg-surface shadow-lg ring-1 ring-border py-1">
                  <button
                    role="menuitem"
                    disabled={changes.length === 0 && !isDeleted}
                    onClick={() => { session.discardDocument(doc.filename); setDiscardMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-bg disabled:opacity-40 disabled:hover:bg-transparent"
                    style={{ color: INK }}
                  >
                    Discard changes to this document
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { session.discardAllDocuments(); setDiscardMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-danger-bg"
                  >
                    Discard changes to all documents ({session.viewerDocumentCount})
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {hasViewerChanges && (
          <button
            onClick={onSaveAndClose}
            className="px-4 py-1.5 text-sm font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
            style={{ backgroundColor: PRIMARY }}
          >
            Save changes ({session.viewerChangeCount})
          </button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Page rail: jump between this document's own pages, like a normal
            PDF viewer's page panel — on the left, where readers expect it. */}
        {!isMobile && (
          <PageThumbnailRail
            totalPages={page.total}
            currentPage={page.current}
            onSelectPage={(pageNumber) => scrollToPageIndex(pageNumber - 1)}
            pdfSource={pdfSource}
          />
        )}

        {/* Document */}
        <div className="relative flex-1 min-w-0 flex flex-col" style={{ backgroundColor: CANVAS_BG }}>
          {isDeleted && (
            <div className="flex items-center justify-center gap-3 px-4 py-2 text-sm bg-danger-bg text-danger-text border-b border-danger-border">
              <span>This document will be removed when you close.</span>
              <button onClick={() => session.toggleDelete(doc.filename)} className="font-medium underline underline-offset-2">
                Keep it
              </button>
            </div>
          )}
          <div ref={scrollRef} className="flex-1 overflow-auto">
            <div className="px-2 sm:px-6 pb-24" style={{ minWidth: pageWidth + (isMobile ? 16 : 48) }}>
              {renderDocument()}
            </div>
          </div>

          {mode === 'redact' && redaction.source && !redaction.unavailable && (
            <ToolPill
              tool={tool}
              onTool={setTool}
              style={style}
              onStyle={setStyle}
              canUndo={changes.length > 0}
              canRedo={redoStack.length > 0}
              onUndo={undo}
              onRedo={redo}
            />
          )}

          {/* Redactions drawer: opened on demand from the header's
              "Redactions" toggle rather than pinned as a permanent column —
              it overlays the document switcher on the right instead of
              competing with it for space. */}
          {mode === 'redact' && !isMobile && redactionsDrawerOpen && redaction.source && !redaction.unavailable && (
            <div className="absolute inset-y-0 right-0 z-20 flex">
              <div className="fixed inset-0 -z-10" onClick={() => setRedactionsDrawerOpen(false)} aria-hidden="true" />
              <RedactionsPanel
                onClose={() => setRedactionsDrawerOpen(false)}
                onDiscard={() => session.discardDocument(doc.filename)}
                pages={redaction.source.pages}
                regions={redaction.source.regions}
                changes={changes}
                onChange={setChanges}
                hoveredId={hoveredId}
                onHover={setHoveredId}
                scrollToPage={(pageNumber) => scrollToPageIndex(redaction.source!.pages.findIndex((p) => p.pageNumber === pageNumber))}
              />
            </div>
          )}
        </div>

        {/* Document switcher: jump between this case's other reports — on
            the right, since the left is now this document's own pages. */}
        {!isMobile && documents.length > 1 && (
          <nav className="w-28 flex-shrink-0 overflow-y-auto border-l border-border bg-surface p-2 space-y-2" aria-label="Documents">
            {documents.map((d) => {
              const active = d.filename === doc.filename;
              const edited = (session.redactions[d.filename]?.length ?? 0) > 0;
              const deleted = session.deletes.includes(d.filename);
              const updating = updatingFilenames.has(d.filename);
              return (
                <button
                  key={d.filename}
                  onClick={() => selectDocument(d.filename)}
                  aria-current={active ? 'true' : undefined}
                  className={`w-full text-left rounded-lg p-1 transition-colors ${active ? 'bg-status-processing-bg' : 'hover:bg-bg'}`}
                >
                  <div
                    className={`relative aspect-[3/4] rounded-md overflow-hidden bg-bg flex items-center justify-center border ${
                      active ? 'border-primary ring-2 ring-primary' : 'border-border'
                    } ${deleted ? 'opacity-40' : ''}`}
                  >
                    {d.thumbnail ? (
                      <img src={d.thumbnail} alt="" className="w-full h-full object-contain bg-surface" />
                    ) : (
                      <FileText className="w-6 h-6 text-text-faint" aria-hidden="true" />
                    )}
                    {(edited || deleted || updating) && (
                      <span
                        className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-on-solid shadow ${
                          updating ? 'bg-neutral-solid' : deleted ? 'bg-danger-solid' : 'bg-success-solid'
                        }`}
                      >
                        {updating ? <Loader2 className="w-3 h-3 animate-spin" /> : deleted ? <Trash2 className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      </span>
                    )}
                  </div>
                  <p className={`mt-1 text-[11px] leading-tight line-clamp-2 ${deleted ? 'line-through text-text-subtle' : ''}`} style={deleted ? undefined : { color: INK }}>
                    {d.displayName}
                  </p>
                </button>
              );
            })}
          </nav>
        )}
      </div>
      {confirmLeave && (
        <div className="fixed inset-0 z-[120000] flex items-center justify-center px-4" role="alertdialog" aria-modal="true" aria-labelledby="discard-title">
          <div className="absolute inset-0 bg-overlay" onClick={() => setConfirmLeave(false)} aria-hidden="true" />
          <div className="relative w-full max-w-md rounded-xl bg-surface shadow-xl p-6">
            <h3 id="discard-title" className="text-base font-semibold" style={{ color: INK }}>
              Discard your changes?
            </h3>
            <p className="mt-2 text-sm text-text-muted">
              {session.viewerChangeCount} unsaved {session.viewerChangeCount === 1 ? 'change' : 'changes'} to{' '}
              {session.viewerDocumentCount} {session.viewerDocumentCount === 1 ? 'document' : 'documents'} will be discarded.
              Changes you already saved aren’t affected.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                autoFocus
                onClick={() => setConfirmLeave(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-text hover:bg-bg"
              >
                Keep editing
              </button>
              <button onClick={discardAndLeave} className="px-4 py-2 text-sm font-medium rounded-lg text-on-solid bg-danger-solid hover:bg-danger-solid-hover">
                Discard and go back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(workspace, document.body);
}

function DocumentStateChip({ edited, deleted, updating }: { edited: boolean; deleted: boolean; updating: boolean }) {
  if (updating) {
    return (
      <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-bg text-text-muted">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> Updating
      </span>
    );
  }
  if (deleted) {
    return <span className="flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-danger-bg text-danger-text">Removing</span>;
  }
  if (edited) {
    return (
      <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-success-bg text-success">
        <Check className="w-3 h-3" aria-hidden="true" /> Saved
      </span>
    );
  }
  return null;
}

interface ToolPillProps {
  tool: RedactionTool;
  onTool: (tool: RedactionTool) => void;
  style: RedactionStyle;
  onStyle: (style: RedactionStyle) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

function ToolPill({ tool, onTool, style, onStyle, canUndo, canRedo, onUndo, onRedo }: ToolPillProps) {
  const toolButton = (value: RedactionTool, label: string, Icon: typeof Square) => (
    <button
      onClick={() => onTool(value)}
      aria-pressed={tool === value}
      className={`flex items-center gap-1.5 px-3 h-9 rounded-full text-sm font-medium transition-colors ${
        tool === value ? 'text-on-solid' : 'text-text-muted hover:bg-surface-muted'
      }`}
      style={tool === value ? { backgroundColor: PRIMARY } : undefined}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div data-tour="redact-tools" className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1 p-1 rounded-full bg-surface shadow-lg ring-1 ring-border">
      {toolButton('box', 'Box', Square)}
      {toolButton('freehand', 'Draw', PenTool)}
      <span className="w-px h-6 bg-border mx-1" aria-hidden="true" />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Redaction fill">
        {STYLE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={style === opt.value}
            aria-label={`${opt.label} fill`}
            title={`${opt.label} fill`}
            onClick={() => onStyle(opt.value)}
            className={`w-9 h-9 rounded-full flex items-center justify-center ${style === opt.value ? 'ring-2 ring-primary' : 'hover:bg-surface-muted'}`}
          >
            <span className="w-5 h-5 rounded-full border border-border-strong" style={{ backgroundColor: styleFill(opt.value) }} />
          </button>
        ))}
      </div>
      <span className="w-px h-6 bg-border mx-1" aria-hidden="true" />
      <button onClick={onUndo} disabled={!canUndo} className="w-9 h-9 rounded-full flex items-center justify-center text-text-muted hover:bg-surface-muted disabled:opacity-30" aria-label="Undo">
        <Undo2 className="w-4 h-4" />
      </button>
      <button onClick={onRedo} disabled={!canRedo} className="w-9 h-9 rounded-full flex items-center justify-center text-text-muted hover:bg-surface-muted disabled:opacity-30" aria-label="Redo">
        <Redo2 className="w-4 h-4" />
      </button>
    </div>
  );
}

interface RedactionsPanelProps {
  onClose: () => void;
  onDiscard: () => void;
  pages: OriginalPage[];
  regions: RedactionRecord[];
  changes: LocalChange[];
  onChange: (changes: LocalChange[]) => void;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  scrollToPage: (pageNumber: number) => void;
}

function RedactionsPanel({ onClose, onDiscard, pages: originalPages, regions, changes, onChange, hoveredId, onHover, scrollToPage }: RedactionsPanelProps) {
  const revealed = new Set(
    changes.filter((c): c is Extract<LocalChange, { action: 'remove' }> => c.action === 'remove').map((c) => c.redactionId)
  );
  const adds = changes.filter((c): c is Extract<LocalChange, { action: 'add' }> => c.action === 'add');
  const pages = Array.from(new Set([...regions.map((r) => r.page_number), ...adds.map((a) => a.pageNumber)])).sort((a, b) => a - b);

  const toggle = (region: RedactionRecord) =>
    onChange(
      revealed.has(region.id)
        ? changes.filter((c) => !(c.action === 'remove' && c.redactionId === region.id))
        : [...changes, { localId: `remove-${region.id}-${Date.now()}`, action: 'remove', redactionId: region.id }]
    );

  const pageUrl = (pageNumber: number) => originalPages.find((p) => p.pageNumber === pageNumber)?.url;

  const rowClass = (id: string) =>
    `w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${hoveredId === id ? 'bg-status-processing-bg' : 'hover:bg-bg'}`;

  return (
    <aside
      className="content-reveal relative w-72 flex-shrink-0 overflow-y-auto border-l border-border bg-surface shadow-xl"
      aria-label="Redactions on this document"
    >
      <div className="sticky top-0 bg-surface px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-text-muted">Redactions</p>
          <div className="flex items-center gap-3">
            {changes.length > 0 && (
              <button onClick={onDiscard} className="text-xs font-medium text-text-muted hover:text-danger">
                Discard changes
              </button>
            )}
            <button onClick={onClose} className="p-1 -mr-1 rounded hover:bg-bg text-text-muted" aria-label="Close redactions panel">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <p className="text-xs text-text-subtle mt-0.5">
          {regions.length - revealed.size + adds.length} hidden{revealed.size > 0 ? `, ${revealed.size} to reveal` : ''}
        </p>
      </div>
      {pages.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted">Nothing is hidden yet. Drag across the page to hide something.</p>
      ) : (
        <div className="p-2 space-y-3">
          {pages.map((pageNumber) => (
            <section key={pageNumber}>
              <button onClick={() => scrollToPage(pageNumber)} className="px-2 text-xs text-text-subtle hover:text-text-muted">
                Page {pageNumber + 1}
              </button>
              <ul className="mt-1 space-y-0.5">
                {regions.filter((r) => r.page_number === pageNumber).map((region) => {
                  const isRevealed = revealed.has(region.id);
                  const stroke = isRevealed ? REGION_COLORS.pendingReveal : region.source === 'manual' ? REGION_COLORS.manual : REGION_COLORS.automated;
                  return (
                    <li key={region.id}>
                      <div className={rowClass(region.id)} onMouseEnter={() => onHover(region.id)} onMouseLeave={() => onHover(null)}>
                        <span
                          className={`w-4 h-4 rounded-sm flex-shrink-0 border-2 ${isRevealed ? 'border-dashed' : ''}`}
                          style={{ borderColor: stroke, backgroundColor: isRevealed ? 'transparent' : styleFill(region.style) }}
                          aria-hidden="true"
                        />
                        <span className={`flex-1 min-w-0 ${isRevealed ? 'opacity-60' : ''}`}>
                          {pageUrl(pageNumber) && <RegionSnippet pageUrl={pageUrl(pageNumber)!} bbox={region.bbox} />}
                          <span className="block text-[11px] text-text-subtle truncate">
                            {isRevealed ? 'Will be visible' : humanizeCategory(region)}
                          </span>
                        </span>
                        <button
                          onClick={() => toggle(region)}
                          className={`text-xs font-medium px-2 py-1 rounded ${isRevealed ? 'text-text-muted hover:bg-surface-muted' : 'text-danger hover:bg-danger-bg'}`}
                        >
                          {isRevealed ? 'Hide again' : 'Reveal'}
                        </button>
                      </div>
                    </li>
                  );
                })}
                {adds.filter((a) => a.pageNumber === pageNumber).map((add) => (
                  <li key={add.localId}>
                    <div className={rowClass(add.localId)} onMouseEnter={() => onHover(add.localId)} onMouseLeave={() => onHover(null)}>
                      <span
                        className="w-4 h-4 rounded-sm flex-shrink-0 border-2 border-dashed"
                        style={{ borderColor: REGION_COLORS.pendingAdd, backgroundColor: styleFill(add.style) }}
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0">
                        {pageUrl(pageNumber) && <RegionSnippet pageUrl={pageUrl(pageNumber)!} bbox={add.bbox} />}
                        <span className="block text-[11px] text-text-subtle">New, added by you</span>
                      </span>
                      <button
                        onClick={() => onChange(changes.filter((c) => c.localId !== add.localId))}
                        className="text-xs font-medium px-2 py-1 rounded text-text-muted hover:bg-surface-muted"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

function useFreshUrl(doc: WorkspaceDocument, requestId: string) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, error: null });
    if (doc.file) {
      objectUrl = URL.createObjectURL(doc.file);
      setState({ url: objectUrl, error: null });
    } else {
      (doc.getUrl ? doc.getUrl() : fetchFreshReportUrl(requestId, doc.filename))
        .then((url) => !cancelled && setState({ url, error: null }))
        .catch((err) => !cancelled && setState({ url: null, error: err instanceof Error ? err.message : "This document couldn't be opened." }));
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.filename, doc.file, requestId, attempt]);
  return { ...state, retry: () => setAttempt((a) => a + 1) };
}

function ImageDocument({ doc, requestId, width }: { doc: WorkspaceDocument; requestId: string; width: number }) {
  const { url, error, retry } = useFreshUrl(doc, requestId);
  const [failed, setFailed] = useState(false);
  if (error || failed) {
    return <DocumentError message={error || "This image couldn't be loaded."} onRetry={() => { setFailed(false); retry(); }} />;
  }
  if (!url) return <DocumentLoading />;
  return (
    <div className="py-4">
      <img src={url} alt={doc.displayName} onError={() => setFailed(true)} className="block mx-auto bg-surface shadow-sm ring-1 ring-border" style={{ width }} />
    </div>
  );
}

function TextDocument({ doc, requestId, width }: { doc: WorkspaceDocument; requestId: string; width: number }) {
  const { url, error, retry } = useFreshUrl(doc, requestId);
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setText(null);
    setLoadError(null);
    fetchDocumentBytes(url)
      .then((buf) => !cancelled && setText(new TextDecoder().decode(buf)))
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : "This file couldn't be loaded."));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error || loadError) return <DocumentError message={error || loadError || ''} onRetry={retry} />;
  if (text === null) return <DocumentLoading />;
  return (
    <div className="py-4">
      <pre className="mx-auto bg-surface shadow-sm ring-1 ring-border p-8 whitespace-pre-wrap text-sm leading-relaxed" style={{ width, color: INK }}>
        {text}
      </pre>
    </div>
  );
}
