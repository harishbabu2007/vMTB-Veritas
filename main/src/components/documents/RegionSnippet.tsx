import { useEffect, useRef } from 'react';
import type { RedactionBBox } from '../../services/redactionService';

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string) {
  let pending = imageCache.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    imageCache.set(url, pending);
  }
  return pending;
}

const HEIGHT = 22;
const MAX_WIDTH = 150;

/**
 * A small crop of the original page under a region — what that region hides.
 * Automated detections carry no category, so without this every row in the
 * redactions list reads the same; the snippet is what tells them apart.
 * Only ever rendered in the owner's redaction editor, which already shows the
 * unredacted originals.
 */
export function RegionSnippet({ pageUrl, bbox }: { pageUrl: string; bbox: RedactionBBox }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadImage(pageUrl)
      .then((img) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const sx = bbox.x0 * img.naturalWidth;
        const sy = bbox.y0 * img.naturalHeight;
        const sw = Math.max(1, (bbox.x1 - bbox.x0) * img.naturalWidth);
        const sh = Math.max(1, (bbox.y1 - bbox.y0) * img.naturalHeight);
        const dpr = window.devicePixelRatio || 1;
        const scale = HEIGHT / sh;
        const width = Math.min(MAX_WIDTH, sw * scale);
        canvas.style.width = `${width}px`;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
        const ctx = canvas.getContext('2d');
        // Wider than the slot: show the start of the region, like truncated text.
        ctx?.drawImage(img, sx, sy, width / scale, sh, 0, 0, canvas.width, canvas.height);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageUrl, bbox.x0, bbox.y0, bbox.x1, bbox.y1]);

  return <canvas ref={canvasRef} className="block rounded-sm bg-surface-muted" style={{ height: HEIGHT, width: 60 }} aria-hidden="true" />;
}
