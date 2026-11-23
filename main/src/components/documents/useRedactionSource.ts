import { useCallback } from 'react';
import {
  OriginalPage,
  RedactionRecord,
  fetchOriginalPages,
  fetchRedactions,
  toDocumentName,
} from '../../services/redactionService';
import { useRetryable } from '../../hooks/useRetryable';

export interface RedactionSource {
  pages: OriginalPage[];
  /** Currently active regions (automated + manual) as stored on the backend. */
  regions: RedactionRecord[];
}

// Original-page URLs are signed for 15 minutes when fetched. Reuse a load for
// less than that, so switching documents doesn't refetch — and so a page that
// is only scrolled into view (and its image requested) near the end of the
// window still gets a URL that hasn't expired. A page image that fails anyway
// calls refresh() to re-sign.
const CACHE_TTL_MS = 10 * 60 * 1000;
// A transient failure (network blip, cold start) shouldn't surface as an
// error the user has to dismiss with "Try again": retry quietly first.
const RETRY_DELAYS_MS = [600, 1800];

const cache = new Map<string, { at: number; source: RedactionSource }>();

const cacheKey = (caseId: string, filename: string) => `${caseId}:${filename}`;

export function invalidateRedactionSource(caseId: string, filename: string) {
  cache.delete(cacheKey(caseId, filename));
}

function cachedSource(caseId: string, filename: string): RedactionSource | null {
  const cached = cache.get(cacheKey(caseId, filename));
  return cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.source : null;
}

async function loadSource(requestId: string, caseId: string, filename: string): Promise<RedactionSource> {
  const [pages, regions] = await Promise.all([
    fetchOriginalPages(requestId, filename),
    fetchRedactions(caseId, toDocumentName(filename)),
  ]);
  return { pages, regions: regions.filter((r) => r.is_active) };
}

/**
 * The retained unredacted originals of one document plus its active regions —
 * what both redaction editing and the edited-result preview render from.
 * `unavailable` means the document has no retained originals (its 30-day
 * editing window closed, or it predates the editor).
 */
export function useRedactionSource(requestId: string, caseId: string, filename: string | null, enabled: boolean) {
  const active = enabled && filename !== null;

  const { status, data, error, retry } = useRetryable(
    () => loadSource(requestId, caseId, filename as string),
    [requestId, caseId, filename],
    {
      enabled: active,
      peek: () => (filename ? cachedSource(caseId, filename) : null),
      attempts: RETRY_DELAYS_MS.length + 1,
      retryDelaysMs: RETRY_DELAYS_MS,
      onLoaded: (loaded) => {
        if (filename) cache.set(cacheKey(caseId, filename), { at: Date.now(), source: loaded });
      },
      // Keep the diagnostics the old hand-rolled loop had: each failed attempt
      // is worth a line in the console, an exhausted one surfaced to the user.
      onLoadError: (err) => {
        console.warn(`[useRedactionSource] load failed for ${filename}`, err);
      },
    }
  );

  /** Discard any cached load (e.g. its signed URLs expired) and fetch again. */
  const refresh = useCallback(() => {
    if (filename) invalidateRedactionSource(caseId, filename);
    retry();
  }, [caseId, filename, retry]);

  return {
    source: data,
    error: error ? `This document couldn't be loaded for editing. ${error.message}` : null,
    loading: active && status === 'loading',
    unavailable: Boolean(data && data.pages.length === 0),
    retry: refresh,
    refresh,
  };
}
