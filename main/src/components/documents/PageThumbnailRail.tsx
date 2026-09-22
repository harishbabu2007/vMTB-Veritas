import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { FileText } from 'lucide-react';
import { loadPdfjs, fetchDocumentBytes } from '../../utils/pdfjs';
import type { PdfSource } from './PdfPages';

const THUMB_WIDTH = 88;

/**
 * Loads the same document PdfPages/RedactionCanvas already render, purely to
 * generate small thumbnails from it. Deliberately does NOT read from
 * useRedactionSource's retained originals -- those are the pre-redaction
 * pages (RedactionCanvas draws the hide boxes on top of them at render
 * time), so using them directly here would put unredacted PII in the rail.
 * Rendering the actual PDF file (the anonymized, currently-saved version)
 * keeps thumbnails always at least as redacted as what's really stored, at
 * the cost of a second fetch of the same file -- an accepted trade-off for
 * correctness over the alternative of reusing the already-loaded original
 * page images.
 */
function usePdfThumbnailSource(source: PdfSource | null) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    const current = sourceRef.current;
    if (!current) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const data = current.kind === 'file' ? await current.file.arrayBuffer() : await fetchDocumentBytes(await current.getUrl());
        if (cancelled) return;
        const pdfjsLib = await loadPdfjs();
        loaded = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) {
          loaded.destroy();
          return;
        }
        setPdf(loaded);
      } catch (err) {
        console.error('[PageThumbnailRail] Failed to load thumbnails', err);
        if (!cancelled) setPdf(null);
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [source?.key]);
  return pdf;
}

function ThumbCanvas({ pdf, pageNumber }: { pdf: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvas, canvasContext: ctx, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber]);
  return <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />;
}

interface PageThumbnailRailProps {
  totalPages: number;
  /** 1-indexed, matching DocumentWorkspace's page.current. */
  currentPage: number;
  onSelectPage: (pageNumber: number) => void;
  pdfSource: PdfSource | null;
}

/** Desktop page-jump rail for a multi-page document: thumbnails on the left, mirroring how the document switcher works on the right. */
export function PageThumbnailRail({ totalPages, currentPage, onSelectPage, pdfSource }: PageThumbnailRailProps) {
  const pdf = usePdfThumbnailSource(totalPages > 1 ? pdfSource : null);

  if (totalPages <= 1) return null;

  return (
    <nav className="w-28 flex-shrink-0 overflow-y-auto border-r border-border bg-surface p-2 space-y-2" aria-label="Pages">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNumber) => {
        const active = pageNumber === currentPage;
        return (
          <button
            key={pageNumber}
            onClick={() => onSelectPage(pageNumber)}
            aria-current={active ? 'true' : undefined}
            className={`w-full text-left rounded-lg p-1 transition-colors ${active ? 'bg-status-processing-bg' : 'hover:bg-bg'}`}
          >
            <div
              className={`relative aspect-[3/4] rounded-md overflow-hidden bg-bg flex items-center justify-center border ${
                active ? 'border-primary ring-2 ring-primary' : 'border-border'
              }`}
            >
              {pdf ? <ThumbCanvas pdf={pdf} pageNumber={pageNumber} /> : <FileText className="w-5 h-5 text-text-faint" aria-hidden="true" />}
            </div>
            <p className={`mt-1 text-[11px] leading-tight text-center ${active ? 'text-text font-medium' : 'text-text-muted'}`}>{pageNumber}</p>
          </button>
        );
      })}
    </nav>
  );
}
