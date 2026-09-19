import { Info } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SUMMARY_STATUS_META, SUMMARY_STATUS_ORDER } from '../utils/summaryStatus';

const TOOLTIP_WIDTH = 288;
const GAP = 8;
const EDGE = 12;

// Rendered in a portal with fixed positioning so the table's overflow
// clipping can't cut it off.
export function StatusInfoIcon() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  // Place below the icon, flip above if it would run off the bottom, and keep
  // it inside the viewport horizontally.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const height = tooltipRef.current.offsetHeight;
    let top = anchor.bottom + GAP;
    if (top + height > window.innerHeight - EDGE && anchor.top - GAP - height > EDGE) {
      top = anchor.top - GAP - height;
    }
    const centered = anchor.left + anchor.width / 2 - TOOLTIP_WIDTH / 2;
    const left = Math.min(Math.max(centered, EDGE), window.innerWidth - TOOLTIP_WIDTH - EDGE);
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={close}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="What the summary statuses mean"
        aria-describedby={open ? tooltipId : undefined}
        className="p-1 text-text-muted hover:text-text rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Info className="w-4 h-4" />
      </button>

      {open && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="fixed z-[60] bg-surface border border-border rounded-lg shadow-lg p-3 normal-case tracking-normal font-normal text-left pointer-events-none"
          style={{
            width: TOOLTIP_WIDTH,
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <p className="text-xs font-semibold text-text mb-2">Summary status</p>
          <ul className="space-y-2.5">
            {SUMMARY_STATUS_ORDER.map((status) => {
              const meta = SUMMARY_STATUS_META[status];
              return (
                <li key={status} className="space-y-1">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${meta.bg} ${meta.text}`}>
                    {meta.label}
                  </span>
                  <p className="text-xs leading-relaxed text-text-muted">{meta.description}</p>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </>
  );
}
