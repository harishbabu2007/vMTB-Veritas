import { useEffect, useRef, useState } from 'react';
import { PdfPages } from '../documents/PdfPages';
import { SAMPLE_PDF_URL } from '../../onboarding/sampleCase';

// The walkthrough's sample report, rendered in-app the same way real
// documents are. Scrolls inside its own box.
export function SamplePdf({ maxHeight = '70vh' }: { maxHeight?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(0, el.clientWidth - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="overflow-auto rounded-lg border border-border bg-bg p-4" style={{ maxHeight }}>
      {width > 0 && (
        <PdfPages source={{ kind: 'url', key: SAMPLE_PDF_URL, getUrl: async () => SAMPLE_PDF_URL }} width={width} />
      )}
    </div>
  );
}
