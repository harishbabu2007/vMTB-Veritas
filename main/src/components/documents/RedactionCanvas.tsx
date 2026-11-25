import { useCallback, useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Line } from 'react-konva';
import type Konva from 'konva';
import type { RedactionBBox, RedactionRecord, RedactionStyle } from '../../services/redactionService';
import type { LocalChange } from '../../hooks/useDocumentEditSession';
import { useRetryable } from '../../hooks/useRetryable';
import type { RedactionSource } from './useRedactionSource';
import { LazyPage } from './LazyPage';
import { REGION_COLORS, REVEALED_FILL, nextLocalId, styleFill } from './redactionStyles';

export type RedactionTool = 'box' | 'freehand';

interface DragRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What is currently being drawn, if anything. This used to be three pieces of
 * state (`drawing`, `drawRect`, `drawPoints`) that could all be non-default at
 * once — e.g. switching tool mid-drag left the other tool's geometry behind.
 *
 * There is deliberately no separate `start` point on the box: `rect.x/rect.y`
 * already are the press point, and a second copy of it is exactly the kind of
 * duplicate that drifts.
 */
type DrawState =
  | { kind: 'idle' }
  | { kind: 'box'; rect: DragRect }
  | { kind: 'freehand'; points: number[] };

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function bboxArea(b: RedactionBBox) {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

interface RedactionCanvasProps {
  source: RedactionSource;
  /** false = read-only preview of what the document will look like once applied. */
  interactive: boolean;
  changes: LocalChange[];
  onChange: (changes: LocalChange[]) => void;
  tool: RedactionTool;
  style: RedactionStyle;
  width: number;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onPageInfo?: (current: number, total: number) => void;
  /**
   * A page image failed to load — most often its signed URL expired. Return
   * true if the source is being re-signed (the canvas will remount with fresh
   * URLs); false to show the failure on the page.
   */
  onPageImageError?: () => boolean;
}

const DEFAULT_ASPECT = 1.414; // A4 portrait, until a page's real size is known

export function RedactionCanvas(props: RedactionCanvasProps) {
  const { source, width, onPageInfo } = props;
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const total = source.pages.length;

  useEffect(() => {
    onPageInfo?.(1, total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const handleVisible = useCallback((index: number) => onPageInfo?.(index + 1, total), [onPageInfo, total]);
  const handleAspect = useCallback((pageNumber: number, aspect: number) => {
    setAspects((prev) => (prev[pageNumber] === aspect ? prev : { ...prev, [pageNumber]: aspect }));
  }, []);

  return (
    <div className="flex flex-col gap-4 py-4">
      {source.pages.map((page, index) => (
        <LazyPage
          key={page.pageNumber}
          pageIndex={index}
          width={width}
          height={Math.round(width * (aspects[page.pageNumber] ?? DEFAULT_ASPECT))}
          onVisible={handleVisible}
        >
          {() => (
            <RedactionPage
              {...props}
              pageNumber={page.pageNumber}
              url={page.url}
              regions={source.regions.filter((r) => r.page_number === page.pageNumber)}
              onAspect={handleAspect}
            />
          )}
        </LazyPage>
      ))}
    </div>
  );
}

interface RedactionPageProps extends RedactionCanvasProps {
  pageNumber: number;
  url: string;
  regions: RedactionRecord[];
  onAspect: (pageNumber: number, aspect: number) => void;
}

function RedactionPage({
  pageNumber, url, regions, interactive, changes, onChange, tool, style, width, hoveredId, onHover, onAspect, onPageImageError,
}: RedactionPageProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const [draw, setDraw] = useState<DrawState>({ kind: 'idle' });

  const loadImage = useCallback(
    () =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("This page couldn't be loaded."));
        img.src = url;
      }),
    [url]
  );

  const { status: imageStatus, data: image, retry: retryImage } = useRetryable(loadImage, [url, pageNumber], {
    onLoaded: (img) => onAspect(pageNumber, img.naturalHeight / img.naturalWidth),
    // An expired signed URL: let the caller re-sign (the canvas remounts with
    // fresh URLs) instead of showing a failure the owner would only retry.
    onLoadError: () => onPageImageError?.() ?? false,
  });

  if (imageStatus === 'error') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-text-muted">
        <p>This page couldn't be loaded.</p>
        <button
          onClick={retryImage}
          className="px-3 py-1.5 text-sm font-medium rounded-lg border border-border text-text bg-surface hover:bg-surface-hover"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!image) {
    return <div className="absolute inset-0 animate-pulse bg-surface-muted" aria-hidden="true" />;
  }

  const naturalW = image.naturalWidth;
  const naturalH = image.naturalHeight;
  const scale = width / naturalW;

  const removedIds = new Set(
    changes.filter((c): c is Extract<LocalChange, { action: 'remove' }> => c.action === 'remove').map((c) => c.redactionId)
  );
  const pendingAdds = changes.filter(
    (c): c is Extract<LocalChange, { action: 'add' }> => c.action === 'add' && c.pageNumber === pageNumber
  );
  // Largest first, so a region nested inside another stays clickable on top.
  const orderedRegions = [...regions].sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));

  const px = (b: RedactionBBox) => ({
    x: b.x0 * naturalW,
    y: b.y0 * naturalH,
    width: (b.x1 - b.x0) * naturalW,
    height: (b.y1 - b.y0) * naturalH,
  });

  const toggleRegion = (region: RedactionRecord) => {
    if (removedIds.has(region.id)) {
      onChange(changes.filter((c) => !(c.action === 'remove' && c.redactionId === region.id)));
    } else {
      onChange([...changes, { localId: nextLocalId('remove'), action: 'remove', redactionId: region.id }]);
    }
  };

  const pointer = () => stageRef.current?.getRelativePointerPosition() ?? null;

  const handleDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    // Start drawing only on the page itself — a press on a region toggles it instead.
    const onPage = e.target === e.target.getStage() || e.target.getClassName() === 'Image';
    if (!interactive || !onPage) return;
    const pos = pointer();
    if (!pos) return;
    setDraw(
      tool === 'box'
        ? { kind: 'box', rect: { x: pos.x, y: pos.y, width: 0, height: 0 } }
        : { kind: 'freehand', points: [pos.x, pos.y] }
    );
  };

  const handleMove = () => {
    const pos = pointer();
    if (!pos) return;
    setDraw((current) => {
      if (current.kind === 'box') {
        return { kind: 'box', rect: { ...current.rect, width: pos.x - current.rect.x, height: pos.y - current.rect.y } };
      }
      if (current.kind === 'freehand') {
        return { kind: 'freehand', points: [...current.points, pos.x, pos.y] };
      }
      return current;
    });
  };

  const handleUp = () => {
    if (draw.kind === 'idle') return;
    let x0: number, y0: number, x1: number, y1: number;
    if (draw.kind === 'box') {
      x0 = Math.min(draw.rect.x, draw.rect.x + draw.rect.width);
      y0 = Math.min(draw.rect.y, draw.rect.y + draw.rect.height);
      x1 = Math.max(draw.rect.x, draw.rect.x + draw.rect.width);
      y1 = Math.max(draw.rect.y, draw.rect.y + draw.rect.height);
    } else if (draw.points.length >= 4) {
      const xs = draw.points.filter((_, i) => i % 2 === 0);
      const ys = draw.points.filter((_, i) => i % 2 === 1);
      x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys);
    } else {
      setDraw({ kind: 'idle' });
      return;
    }
    setDraw({ kind: 'idle' });
    // Ignore accidental clicks/taps: under ~6 screen px in either direction.
    if ((x1 - x0) * scale < 6 || (y1 - y0) * scale < 6) return;
    onChange([
      ...changes,
      {
        localId: nextLocalId('add'),
        action: 'add',
        pageNumber,
        style,
        bbox: { x0: clamp01(x0 / naturalW), y0: clamp01(y0 / naturalH), x1: clamp01(x1 / naturalW), y1: clamp01(y1 / naturalH) },
      },
    ]);
  };

  const setCursor = (cursor: string) => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  };
  const drawCursor = interactive ? 'crosshair' : 'default';

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={Math.round(naturalH * scale)}
      scaleX={scale}
      scaleY={scale}
      style={{ cursor: drawCursor }}
      onMouseDown={handleDown}
      onMouseMove={handleMove}
      onMouseUp={handleUp}
      onMouseLeave={handleUp}
      onTouchStart={handleDown}
      onTouchMove={handleMove}
      onTouchEnd={handleUp}
    >
      <Layer listening={interactive}>
        <KonvaImage image={image} width={naturalW} height={naturalH} />
      </Layer>
      <Layer listening={interactive}>
        {orderedRegions.map((region) => {
          const revealed = removedIds.has(region.id);
          const hovered = hoveredId === region.id;
          const handlers = interactive
            ? {
                onClick: () => toggleRegion(region),
                onTap: () => toggleRegion(region),
                onMouseEnter: () => { setCursor('pointer'); onHover(region.id); },
                onMouseLeave: () => { setCursor(drawCursor); onHover(null); },
              }
            : {};
          if (revealed) {
            return interactive ? (
              <Rect
                key={region.id}
                {...px(region.bbox)}
                fill={REVEALED_FILL}
                stroke={REGION_COLORS.pendingReveal}
                strokeWidth={hovered ? 3 : 2}
                strokeScaleEnabled={false}
                dash={[6, 4]}
                {...handlers}
              />
            ) : null;
          }
          return (
            <Rect
              key={region.id}
              {...px(region.bbox)}
              fill={styleFill(region.style)}
              stroke={interactive ? (region.source === 'manual' ? REGION_COLORS.manual : REGION_COLORS.automated) : undefined}
              strokeWidth={interactive ? (hovered ? 3 : 1.5) : 0}
              strokeScaleEnabled={false}
              {...handlers}
            />
          );
        })}

        {pendingAdds.map((change) => {
          const hovered = hoveredId === change.localId;
          const remove = () => onChange(changes.filter((c) => c.localId !== change.localId));
          return (
            <Rect
              key={change.localId}
              {...px(change.bbox)}
              fill={styleFill(change.style)}
              stroke={interactive ? REGION_COLORS.pendingAdd : undefined}
              strokeWidth={interactive ? (hovered ? 3 : 2) : 0}
              strokeScaleEnabled={false}
              dash={[6, 4]}
              {...(interactive
                ? {
                    onClick: remove,
                    onTap: remove,
                    onMouseEnter: () => { setCursor('pointer'); onHover(change.localId); },
                    onMouseLeave: () => { setCursor(drawCursor); onHover(null); },
                  }
                : {})}
            />
          );
        })}

        {draw.kind === 'box' && (
          <Rect {...draw.rect} stroke={REGION_COLORS.pendingAdd} strokeWidth={2} strokeScaleEnabled={false} dash={[4, 4]} fill={styleFill(style)} opacity={0.85} />
        )}
        {draw.kind === 'freehand' && draw.points.length >= 4 && (
          <Line points={draw.points} stroke={REGION_COLORS.pendingAdd} strokeWidth={2} strokeScaleEnabled={false} />
        )}
      </Layer>
    </Stage>
  );
}
