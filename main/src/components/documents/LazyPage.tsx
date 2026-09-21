import { ReactNode, useEffect, useRef, useState } from 'react';

interface LazyPageProps {
  width: number;
  height: number;
  pageIndex: number;
  /** Called when this page becomes the one most in view. */
  onVisible?: (pageIndex: number) => void;
  children: (active: boolean) => ReactNode;
}

/**
 * Reserves a page's exact footprint and only mounts its (expensive) content
 * while it is near the viewport, so a 50-page document costs a few canvases,
 * not fifty. Keeping the box sized up front means the scroll position never
 * jumps as pages load.
 */
export function LazyPage({ width, height, pageIndex, onVisible, children }: LazyPageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearObserver = new IntersectionObserver(
      ([entry]) => setActive(entry.isIntersecting),
      { rootMargin: '1200px 0px' }
    );
    const centerObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onVisible?.(pageIndex);
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    nearObserver.observe(el);
    centerObserver.observe(el);
    return () => {
      nearObserver.disconnect();
      centerObserver.disconnect();
    };
  }, [pageIndex, onVisible]);

  return (
    <div
      ref={ref}
      data-page-index={pageIndex}
      className="relative bg-paper shadow-sm ring-1 ring-border mx-auto"
      style={{ width, height }}
    >
      {active && children(active)}
    </div>
  );
}
