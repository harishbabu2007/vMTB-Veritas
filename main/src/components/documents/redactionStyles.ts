import type { RedactionStyle } from '../../services/redactionService';

// theme-allow-start: these are drawn on the document page itself (white paper in
// both themes), so they are the document's colours, not the app's.
/** Stroke colours are the editor's legend — the changes panel uses the same swatches. */
export const REGION_COLORS = {
  automated: '#F97316',
  manual: '#16A34A',
  pendingAdd: '#4A90E2',
  pendingReveal: '#EF4444',
} as const;

export function styleFill(style: RedactionStyle): string {
  switch (style) {
    case 'blackout':
      return '#000000';
    case 'blur':
      // A tinted box stands in for blur; the real Gaussian blur is applied
      // server-side when the document is regenerated.
      return 'rgba(107,114,128,0.9)';
    default:
      return '#ffffff';
  }
}

/** Faint tint over a region whose redaction is being revealed. */
export const REVEALED_FILL = 'rgba(239,68,68,0.06)';
// theme-allow-end

let localIdCounter = 0;
export function nextLocalId(prefix: string) {
  localIdCounter += 1;
  return `${prefix}-${Date.now()}-${localIdCounter}`;
}
