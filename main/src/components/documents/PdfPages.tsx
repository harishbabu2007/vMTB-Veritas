import { useCallback, useEffect, useRef } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdfjs, fetchDocumentBytes } from '../../utils/pdfjs';
import { useRetryable } from '../../hooks/useRetryable';
import { LazyPage } from './LazyPage';
import { DocumentError, DocumentLoading } from './DocumentStatus';

export type PdfSource =
  | { kind: 'url'; key: string; getUrl: () => Promise<string> }
  | { kind: 'file'; key: string; file: File };

interface PdfPagesProps {
  source: PdfSource;
  /** Rendered page width in CSS px — the workspace passes fit-to-width × zoom. */
  width: number;
  onPageInfo?: (current: number, total: number) => void;
}

interface PageSize {
  width: number;
  height: number;
}

interface LoadedPdf {
  pdf: PDFDocumentProxy;
  sizes: PageSize[];
}

/**
 * Renders a PDF in-app with pdf.js instead of a cross-origin <iframe>.
 *
 * The iframe it replaces had no way to know whether the document loaded: a
 * slow first load (the browser's PDF plugin spinning up) was a blank grey
 * panel for several seconds, and an expired or refused URL rendered S3's raw
 * XML error — both looked like "the viewer didn't open". Fetching the bytes
 * ourselves gives a real loading state, a readable error with retry, pages
 * sized to the available width, and consistent behaviour on mobile browsers
 * that don't render PDFs in iframes at all.
 */
export function PdfPages({ source, width, onPageInfo }: PdfPagesProps) {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const onPageInfoRef = useRef(onPageInfo);
  onPageInfoRef.current = onPageInfo;

  const load = useCallback(async (): Promise<LoadedPdf> => {
    const src = sourceRef.current;
    const data = src.kind === 'file' ? await src.file.arrayBuffer() : await fetchDocumentBytes(await src.getUrl());
    const pdfjsLib = await loadPdfjs();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const sizes: PageSize[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const viewport = (await pdf.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    }
    return { pdf, sizes };
  }, []);

  const { status, data, error, retry } = useRetryable(load, [source.key], {
    onLoaded: (loaded) => onPageInfoRef.current?.(1, loaded.pdf.numPages),
    dispose: (loaded) => {
      void loaded.pdf.destroy();
    },
  });

  // Stable per page count: LazyPage re-subscribes its visibility observers
  // whenever this changes, so a new function every render would re-report
  // visibility. Declared before the early returns below (hooks order).
  const total = data?.sizes.length ?? 0;
  const handleVisible = useCallback((index: number) => onPageInfoRef.current?.(index + 1, total), [total]);

  if (status === 'error') {
    return <DocumentError message={error?.message ?? "This document couldn't be opened."} onRetry={retry} />;
  }
  if (!data || width <= 0) return <DocumentLoading />;

  return (
    <div className="flex flex-col gap-4 py-4">
      {data.sizes.map((size, index) => (
        <LazyPage
          key={index}
          pageIndex={index}
          width={width}
          height={Math.round((width * size.height) / size.width)}
          onVisible={handleVisible}
        >
          {() => <PdfPageCanvas pdf={data.pdf} pageNumber={index + 1} width={width} />}
        </LazyPage>
      ))}
    </div>
  );
}

function PdfPageCanvas({ pdf, pageNumber, width }: { pdf: PDFDocumentProxy; pageNumber: number; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvas, canvasContext: ctx, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, width]);

  return <canvas ref={canvasRef} className="block w-full h-full" aria-label={`Page ${pageNumber}`} />;
}
