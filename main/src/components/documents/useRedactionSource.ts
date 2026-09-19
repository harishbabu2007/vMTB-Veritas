import { useCallback, useEffect, useState } from 'react';
import {
  OriginalPage,
  RedactionRecord,
  fetchOriginalPages,
  fetchRedactions,
  toDocumentName,
} from '../../services/redactionService';

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

export function invalidateRedactionSource(caseId: string, filename: string) {
  cache.delete(`${caseId}:${filename}`);
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
  const [source, setSource] = useState<RedactionSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !filename) return;
    const key = `${caseId}:${filename}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setSource(cached.source);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setSource(null);
    setError(null);
    setLoading(true);
    (async () => {
      let lastError: unknown = null;
      for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
        if (i > 0) await new Promise((r) => window.setTimeout(r, RETRY_DELAYS_MS[i - 1]));
        if (cancelled) return;
        const startedAt = Date.now();
        try {
          const loaded = await loadSource(requestId, caseId, filename);
          cache.set(key, { at: startedAt, source: loaded });
          if (!cancelled) {
            setSource(loaded);
            setLoading(false);
          }
          return;
        } catch (err) {
          lastError = err;
          console.warn(`[useRedactionSource] load attempt ${i + 1} failed for ${filename}`, err);
        }
      }
      console.error(`[useRedactionSource] giving up on ${filename}`, lastError);
      if (!cancelled) {
        const reason = lastError instanceof Error ? lastError.message : String(lastError);
        setError(`This document couldn't be loaded for editing. ${reason}`);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, caseId, filename, enabled, attempt]);

  /** Discard any cached load (e.g. its signed URLs expired) and fetch again. */
  const refresh = useCallback(() => {
    if (filename) invalidateRedactionSource(caseId, filename);
    setAttempt((a) => a + 1);
  }, [caseId, filename]);

  return {
    source,
    error,
    loading,
    unavailable: Boolean(source && source.pages.length === 0),
    retry: refresh,
    refresh,
  };
}
