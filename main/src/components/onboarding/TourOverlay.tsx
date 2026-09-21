import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useOnboarding } from '../../context/OnboardingContext';
import { useIsMobile } from '../../hooks/useMobile';
import { useTourAction } from '../../hooks/useTourGroup';
import { DismissButton } from '../DismissButton';
import { ACT_TARGETS, TOUR_GROUPS, TourGroupId, TourStep, resolveText, targetNames } from '../../onboarding/steps';

// Above the document viewer (110000), so its tips can show over it, and below
// the confirm dialogs (120000) and toasts (130000).
export const TOUR_LAYER_Z = 115000;

const POPOVER_WIDTH = 320;
const GAP = 12;
const EDGE = 12;
const SPOT_PAD = 6;
const START_WAIT_MS = 3000;
const LOST_MS = 1000;
const POLL_MS = 200;
// After a "run" step, how long the next step's control may take to appear.
const NEXT_WAIT_MS = 1500;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const isShown = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return el.isConnected && r.width > 0 && r.height > 0;
};

// The first of the step's targets that is actually on screen.
const findTarget = (names: string[]): HTMLElement | null => {
  for (const name of names) {
    const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
    if (el && isShown(el)) return el;
  }
  return null;
};

// Any open app modal. The tour's own dialog is ignored, and so are screens
// marked as tour hosts (the document viewer, whose tips show over it).
const modalOpen = () =>
  document.querySelector('[aria-modal="true"]:not([data-tour-dialog]):not([data-tour-host])') !== null;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Sticky/fixed bars are always on screen; scrolling the page to them only
// jolts it. They may still need scrolling sideways (the phone tab strip).
const inStickyBar = (el: HTMLElement) => Boolean(el.closest('.desktop-nav, .mobile-nav-header, .case-tabs-sticky'));

const firstName = (name?: string | null): string | null => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  // Keep a title with the name it belongs to: "Dr. Asha", not "Dr.".
  if (/^(dr|prof)\.?$/i.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}`;
  return parts[0];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The one place the walkthrough renders. Mounted once in App; shows whatever
// group OnboardingContext says is active.
export function TourOverlay() {
  const { activeGroup, activeStart } = useOnboarding();
  const navigate = useNavigate();
  // The walkthrough's own moves between screens. Each is a button the user
  // pressed in a tour card.
  useTourAction('go-mtbs', async () => navigate('/mtbs'));
  useTourAction('go-sample-board', async () => navigate('/sample-board'));
  useTourAction('go-new-case', async () => navigate('/cases/new/step-1'));
  if (!activeGroup) return null;
  return <TourRun key={`${activeGroup}:${activeStart}`} groupId={activeGroup} start={activeStart} />;
}

function TourRun({ groupId, start }: { groupId: TourGroupId; start: number }) {
  const { completeGroup, stopAll, deferGroup, runAction } = useOnboarding();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const group = TOUR_GROUPS[groupId];
  const steps = group.steps;
  const guided = group.kind === 'guided';

  const [index, setIndex] = useState<number | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const [progress, setProgress] = useState<{ position: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const popoverRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const available = useCallback((step: TourStep) => {
    const names = targetNames(step, isMobileRef.current);
    return names.length === 0 || findTarget(names) !== null;
  }, []);

  // The nearest step from `from` (in direction `dir`) that can be shown now.
  const nextAvailable = useCallback((from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < steps.length; i += dir) {
      if (available(steps[i])) return i;
    }
    return -1;
  }, [steps, available]);

  const finish = useCallback(() => completeGroup(groupId), [completeGroup, groupId]);
  // Closing: a tip closes on its own; in the guided flow, closing is skipping.
  const close = guided ? stopAll : finish;

  const go = useCallback((dir: 1 | -1) => {
    if (index === null) return;
    const next = nextAvailable(index + dir, dir);
    if (next !== -1) setIndex(next);
    else if (dir === 1) finish();
  }, [index, nextAvailable, finish]);

  // Anything still running stops when this group goes away.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Start once the page is settled: no modal open and at least one step's
  // target on screen. If nothing appears in time, give up for this visit
  // without marking the group seen.
  useEffect(() => {
    if (index !== null) return;
    const deadline = Date.now() + START_WAIT_MS;
    const tryStart = () => {
      if (modalOpen()) return false;
      const first = nextAvailable(start, 1);
      if (first === -1) return false;
      setIndex(first);
      return true;
    };
    if (tryStart()) return;
    const timer = window.setInterval(() => {
      if (tryStart()) {
        window.clearInterval(timer);
      } else if (Date.now() > deadline && !modalOpen()) {
        window.clearInterval(timer);
        deferGroup(groupId);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [index, start, nextAvailable, deferGroup, groupId]);

  // Follow the current step's target through scrolling, resizing, re-renders
  // and breakpoint changes. If it disappears for good, move on.
  useEffect(() => {
    if (index === null) return;
    const step = steps[index];
    let el: HTMLElement | null = null;
    let lostSince: number | null = null;
    let raf = 0;
    let scrolled = false;

    const tick = () => {
      const names = targetNames(step, isMobileRef.current);
      if (names.length === 0) {
        setTarget(null);
        setRect(null);
        return;
      }
      // Re-query when the element went away or the preferred variant changed
      // (breakpoint flip).
      const preferred = findTarget(names);
      if (preferred !== el) {
        el = preferred;
        setTarget(el);
      }
      if (!el) {
        lostSince ??= Date.now();
        if (Date.now() - lostSince > LOST_MS) {
          const next = nextAvailable(index + 1, 1);
          if (next !== -1) setIndex(next);
          else deferGroup(groupId);
          return;
        }
      } else {
        lostSince = null;
        if (!scrolled) {
          scrolled = true;
          const box = el.getBoundingClientRect();
          const behavior = reducedMotion() ? 'auto' : 'smooth';
          if (inStickyBar(el)) {
            if (box.left < 0 || box.right > window.innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
          } else if (box.top < 80 || box.bottom > window.innerHeight - 16) {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
          }
        }
        const b = el.getBoundingClientRect();
        const next = { top: b.top, left: b.left, width: b.width, height: b.height };
        setRect(prev =>
          prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5 &&
          Math.abs(prev.width - next.width) < 0.5 && Math.abs(prev.height - next.height) < 0.5
            ? prev
            : next
        );
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [index, steps, nextAvailable, deferGroup, groupId]);

  // "2 of 3" counts the pointing steps that can actually show here, so a
  // skipped one (e.g. Verify on an already-verified case) doesn't leave a gap.
  useEffect(() => {
    if (index === null) return;
    const shown = steps
      .map((step, i) => ({ step, i }))
      .filter(({ step }) => step.target !== null && available(step));
    const position = shown.findIndex(s => s.i === index);
    setProgress(position === -1 ? null : { position: position + 1, total: shown.length });
  }, [index, steps, available, isMobile]);

  const visible = index !== null;
  const step = index !== null ? steps[index] : null;
  // An "act" step lets the user click the highlighted control, and only
  // controls on the allowlist.
  const isAct = Boolean(step?.act && target && ACT_TARGETS.has(target.dataset.tour ?? ''));

  // Focus goes back where it was when the tour closes.
  useEffect(() => {
    if (!visible) return;
    restoreFocusRef.current = document.activeElement;
    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [visible]);

  // While a step shows, the page behind is inert: Tab stays in the popover
  // and screen readers skip the page. An "act" step leaves the page live so
  // its control can be used; the layer still blocks everything else.
  useEffect(() => {
    if (!visible || isAct) return;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, [visible, isAct]);

  // Files dropped anywhere while the tour is up are ignored (without this
  // the browser would open them).
  useEffect(() => {
    if (!visible) return;
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, [visible]);

  // A pointing step's popover is focusable only once it is measured and
  // placed (it renders hidden until then, and hidden elements can't take
  // focus). An "act" step focuses the control to use.
  const shown = rect !== null && placement !== null;
  useEffect(() => {
    if (index === null) return;
    if (isAct) target?.focus({ preventScroll: true });
    else primaryRef.current?.focus({ preventScroll: true });
  }, [index, shown, isAct, target]);

  // Using the highlighted control completes the step; the control's own
  // handler then runs as usual. A form that can't submit yet (a required
  // field is empty) ends the group instead, so the user can fill it in.
  useEffect(() => {
    if (index === null || !isAct || !target) return;
    const onClick = () => {
      const form = target instanceof HTMLButtonElement && target.type === 'submit' ? target.form : null;
      if (form && !form.checkValidity()) {
        finish();
        return;
      }
      if (nextAvailable(index + 1, 1) === -1) finish();
      else setIndex(nextAvailable(index + 1, 1));
    };
    target.addEventListener('click', onClick, { capture: true });
    return () => target.removeEventListener('click', onClick, { capture: true });
  }, [index, isAct, target, nextAvailable, finish]);

  // A "run" step: the primary button does something (drop in the sample,
  // mark the sample ready, open the next screen), then the tour moves on.
  const runStep = useCallback(async () => {
    if (index === null || !step?.run || running) return;
    const last = nextAvailable(index + 1, 1) === -1 && !steps.slice(index + 1).some(s => s.target !== null);
    const controller = new AbortController();
    abortRef.current = controller;
    setRunError(null);
    setRunning(true);
    try {
      // Moving to another screen ends this group; save that first.
      if (last) finish();
      await runAction(step.run, controller.signal);
      if (controller.signal.aborted || last) return;
      // The next step's control may take a moment to render.
      const deadline = Date.now() + NEXT_WAIT_MS;
      let next = nextAvailable(index + 1, 1);
      while (next !== -1 && next !== index + 1 && Date.now() < deadline && steps[index + 1].target !== null) {
        await sleep(POLL_MS);
        if (controller.signal.aborted) return;
        next = nextAvailable(index + 1, 1);
      }
      if (next !== -1) setIndex(next);
      else finish();
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('Walkthrough step failed', err);
      setRunError(err instanceof Error && err.message ? err.message : 'That didn’t work. Please try again.');
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [index, step, running, nextAvailable, steps, finish, runAction]);

  const primary = useCallback(() => {
    if (step?.run) void runStep();
    else go(1);
  }, [step, runStep, go]);

  useEffect(() => {
    if (!visible) return;
    // Keys the tour uses don't reach the page (or the document viewer, which
    // also listens for Escape and the arrows).
    const claim = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        claim(e);
        abortRef.current?.abort();
        close();
      } else if (e.key === 'ArrowRight' && !isAct && !step?.run) {
        claim(e);
        go(1);
      } else if (e.key === 'ArrowLeft' && !running) {
        claim(e);
        go(-1);
      } else if (e.key === 'Tab' && popoverRef.current) {
        const focusable = [
          ...(isAct && target ? [target] : []),
          ...Array.from(popoverRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const inside = focusable.includes(document.activeElement as HTMLElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [visible, close, go, isAct, step, running, target]);

  // Desktop: below the target, flipped above if it doesn't fit, kept inside
  // the viewport. Phone: a sheet docked to whichever edge is away from the
  // target, so it never covers it or runs off screen.
  useLayoutEffect(() => {
    if (index === null) return;
    if (!rect) {
      setPlacement(null);
      return;
    }
    if (isMobile) {
      const targetLow = rect.top + rect.height / 2 > window.innerHeight / 2;
      setPlacement(
        targetLow
          ? { left: 16, right: 16, top: 'calc(16px + env(safe-area-inset-top))' }
          : { left: 16, right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom))' }
      );
      return;
    }
    const height = popoverRef.current?.offsetHeight ?? 0;
    const spotTop = rect.top - SPOT_PAD;
    const spotBottom = rect.top + rect.height + SPOT_PAD;
    let top = spotBottom + GAP;
    if (top + height > window.innerHeight - EDGE) {
      const above = spotTop - GAP - height;
      top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - height - EDGE);
    }
    const centered = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
    const left = Math.min(Math.max(centered, EDGE), window.innerWidth - POPOVER_WIDTH - EDGE);
    setPlacement({ top, left, width: POPOVER_WIDTH });
  }, [index, rect, isMobile, runError]);

  if (index === null || !step) return null;

  const ctx = { firstName: firstName(user?.name), isMobile, target };
  const title = resolveText(step.title, ctx) ?? '';
  const body = resolveText(step.body, ctx);
  const isIntro = step.target === null;
  const isLast = nextAvailable(index + 1, 1) === -1;
  const canGoBack = index > 0 && nextAvailable(index - 1, -1) !== -1 && !running;
  const primaryLabel = runError && step.run
    ? 'Try again'
    : step.primaryLabel ?? (isIntro && index === 0 ? 'Show me around' : isLast ? 'Got it' : 'Next');
  const stopLabel = guided ? 'Skip tour' : 'Turn off tips';
  const closeLabel = guided ? 'Close tour' : 'Close tip';
  const buttonSize = isMobile ? 'min-h-[44px] px-4' : 'px-3 py-1.5';
  const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
  const onClose = () => {
    abortRef.current?.abort();
    close();
  };
  const onStop = () => {
    abortRef.current?.abort();
    stopAll();
  };

  const dialog = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal={isAct ? 'false' : 'true'}
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      aria-busy={running || undefined}
      data-tour-dialog
      className={`tour-popover bg-surface text-left border border-border rounded-xl shadow-xl ${isIntro ? 'p-6' : 'p-5'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className={`font-semibold text-text ${isIntro ? 'text-lg' : 'text-base'}`}>{title}</h2>
        {isMobile ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className={`flex-shrink-0 -m-2.5 w-11 h-11 flex items-center justify-center rounded-lg text-text-muted opacity-60 hover:opacity-100 transition ${focusRing}`}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        ) : (
          <DismissButton onClick={onClose} label={closeLabel} className="text-text-muted mt-0.5" />
        )}
      </div>
      {body && (
        <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-text-muted">{body}</p>
      )}
      {runError && (
        <p role="alert" className="mt-2 text-sm text-status-failed-text">{runError}</p>
      )}
      <div className={`flex items-center justify-between gap-3 flex-wrap ${isIntro ? 'mt-6' : 'mt-4'}`}>
        <button
          type="button"
          onClick={onStop}
          className={`text-sm text-text-muted hover:text-text rounded-md transition-colors ${isMobile ? 'min-h-[44px]' : ''} ${focusRing}`}
        >
          {stopLabel}
        </button>
        <div className="flex items-center gap-2 ml-auto">
          {progress && progress.total > 1 && (
            <span className="text-xs text-text-muted tabular-nums mr-1">
              {progress.position} of {progress.total}
            </span>
          )}
          {canGoBack && !isIntro && (
            <button
              type="button"
              onClick={() => go(-1)}
              className={`text-sm font-medium text-text border border-border rounded-lg hover:bg-bg transition-colors ${buttonSize} ${focusRing}`}
            >
              Back
            </button>
          )}
          {step.secondaryLabel && (
            <button
              type="button"
              onClick={() => {
                finish();
                if (step.secondaryRun) void runAction(step.secondaryRun, new AbortController().signal).catch(() => undefined);
              }}
              disabled={running}
              className={`text-sm font-medium text-text border border-border rounded-lg hover:bg-bg transition-colors disabled:opacity-50 ${buttonSize} ${focusRing}`}
            >
              {step.secondaryLabel}
            </button>
          )}
          {!isAct && (
            <button
              ref={primaryRef}
              type="button"
              onClick={primary}
              disabled={running}
              className={`inline-flex items-center gap-1.5 text-sm font-medium text-on-solid bg-primary-solid hover:bg-primary-solid-hover rounded-lg transition-colors disabled:opacity-70 ${buttonSize} ${focusRing}`}
            >
              {running && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const hole = rect && {
    top: rect.top - SPOT_PAD,
    left: rect.left - SPOT_PAD,
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  };
  // Pressing on the backdrop keeps focus in the popover, so the keyboard
  // still works after a stray click.
  const absorb = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  };

  return createPortal(
    // Everything outside the popover absorbs clicks. On a pointing step that
    // includes the highlighted control: the walkthrough only points at it.
    // On an "act" step the control sits in a hole the user can click through.
    <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: TOUR_LAYER_Z }}>
      {hole ? (
        <>
          <div aria-hidden="true" className="tour-spotlight absolute rounded-lg pointer-events-none" style={hole} />
          {isAct ? (
            <>
              <div className="absolute inset-x-0 top-0 pointer-events-auto" style={{ height: Math.max(0, hole.top) }} {...absorb} />
              <div className="absolute inset-x-0 bottom-0 pointer-events-auto" style={{ top: hole.top + hole.height }} {...absorb} />
              <div className="absolute left-0 pointer-events-auto" style={{ top: hole.top, height: hole.height, width: Math.max(0, hole.left) }} {...absorb} />
              <div className="absolute right-0 pointer-events-auto" style={{ top: hole.top, height: hole.height, left: hole.left + hole.width }} {...absorb} />
            </>
          ) : (
            <div className="absolute inset-0 pointer-events-auto" {...absorb} />
          )}
        </>
      ) : (
        <div aria-hidden="true" className="tour-backdrop absolute inset-0 pointer-events-auto" {...absorb} />
      )}

      {isIntro ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div className="w-full max-w-md pointer-events-auto">{dialog}</div>
        </div>
      ) : rect ? (
        <div
          className="fixed pointer-events-auto"
          style={{ ...(placement ?? { top: 0, left: 0, width: POPOVER_WIDTH }), visibility: placement ? 'visible' : 'hidden' }}
        >
          {dialog}
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {progress ? `Step ${progress.position} of ${progress.total}: ${title}` : title}
      </div>
    </div>,
    document.body
  );
}
