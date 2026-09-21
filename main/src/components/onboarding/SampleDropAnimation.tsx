import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileText, MousePointer2 } from 'lucide-react';
import { SAMPLE_FILE_NAME, SAMPLE_PAGE_COUNT } from '../../onboarding/sampleCase';
import { TOUR_LAYER_Z } from './TourOverlay';

const DURATION_MS = 1250;
// When the file is over the drop zone (as a share of the flight), so the
// zone can show its drag-over state.
const OVER_AT = 0.62;

interface Props {
  // The drop zone, in viewport coordinates.
  zone: DOMRect;
  onOver: () => void;
  onDone: () => void;
}

// The walkthrough's one choreographed moment: the sample report, held by a
// pointer, is dragged onto the upload box and dropped. Transform and opacity
// only. Callers skip it under reduced motion.
export function SampleDropAnimation({ zone, onOver, onDone }: Props) {
  const chipRef = useRef<HTMLDivElement>(null);
  const onOverRef = useRef(onOver);
  onOverRef.current = onOver;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const chip = chipRef.current;
    if (!chip) return;
    const w = chip.offsetWidth;
    const h = chip.offsetHeight;
    const vw = window.innerWidth;
    // From above the box's right side, along a shallow arc, into its centre.
    const endX = zone.left + zone.width / 2 - w / 2;
    const endY = zone.top + zone.height / 2 - h / 2;
    const startX = Math.min(vw - w - 16, Math.max(16, zone.left + zone.width * 0.7 - w / 2));
    const startY = Math.max(16, zone.top - h - 64);
    const midX = (startX + endX) / 2 + Math.min(48, vw * 0.06);
    const midY = Math.min(startY, endY) - 20;
    const at = (x: number, y: number, scale: number) => `translate(${x}px, ${y}px) scale(${scale})`;
    const glide = 'cubic-bezier(.2,.8,.2,1)';

    const animation = chip.animate(
      [
        { offset: 0, opacity: 0, transform: at(startX, startY + 8, 0.96), easing: 'ease-out' },
        { offset: 0.14, opacity: 1, transform: at(startX, startY, 1.04), easing: glide },
        { offset: 0.42, opacity: 1, transform: at(midX, midY, 1.04), easing: glide },
        { offset: 0.8, opacity: 1, transform: at(endX, endY, 1.02), easing: 'ease-in' },
        { offset: 1, opacity: 0, transform: at(endX, endY + 4, 0.9) },
      ],
      { duration: DURATION_MS, fill: 'forwards' }
    );
    const overTimer = window.setTimeout(() => onOverRef.current(), DURATION_MS * OVER_AT);
    let cancelled = false;
    animation.finished.then(
      () => {
        if (!cancelled) onDoneRef.current();
      },
      () => undefined
    );
    return () => {
      cancelled = true;
      window.clearTimeout(overTimer);
      animation.cancel();
    };
  }, [zone]);

  return createPortal(
    <div
      ref={chipRef}
      aria-hidden="true"
      className="fixed top-0 left-0 pointer-events-none opacity-0"
      style={{ zIndex: TOUR_LAYER_Z + 1, willChange: 'transform, opacity' }}
    >
      <div className="relative flex items-center gap-2.5 bg-surface border border-border rounded-lg shadow-xl px-3 py-2.5">
        <FileText className="w-6 h-6 text-danger flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text whitespace-nowrap">{SAMPLE_FILE_NAME}</p>
          <p className="text-xs text-text-muted">PDF, {SAMPLE_PAGE_COUNT} pages</p>
        </div>
        <MousePointer2 className="absolute -right-2.5 -bottom-3.5 w-5 h-5 text-text fill-surface drop-shadow" />
      </div>
    </div>,
    document.body
  );
}
