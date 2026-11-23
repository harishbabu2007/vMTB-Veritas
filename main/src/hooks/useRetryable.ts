import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One "load something, then it's loading / ready / failed, with a retry"
 * flow. Five places in the document stack used to spell this out separately
 * (each with its own `loading`, `error` and `attempt` boolean/counter, and
 * each free to disagree with the others). They now share this.
 *
 * The load is re-run when `deps` change or `retry()` is called. Every run is
 * cancellable: a result that arrives after the deps changed (or after
 * unmount) is dropped, and whatever the previous run returned is released
 * through `dispose` so nothing leaks.
 */

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface RetryableLoad<T> {
  status: LoadStatus;
  /** The last successful result, or null while loading / after a failure. */
  data: T | null;
  /** The last failure, in the form the UI shows it. */
  error: Error | null;
  /** Run the load again. */
  retry: () => void;
}

export interface RetryableOptions<T> {
  /** Don't load until this is true. */
  enabled?: boolean;
  /**
   * A synchronously available result (e.g. a cache hit). Returning one skips
   * the loading state entirely, so a cached document doesn't flash a skeleton.
   */
  peek?: () => T | null;
  /** Attempts before a failure is surfaced. Default 1. */
  attempts?: number;
  /** Delay before attempt 2, 3, … Default none (retry immediately). */
  retryDelaysMs?: number[];
  /** Called on each successful load, before the result is shown. */
  onLoaded?: (data: T) => void;
  /**
   * Called on each failed attempt. Return true when the failure was handled
   * elsewhere (e.g. expired signed URLs are being re-signed, and the caller
   * will change the deps): the error is then not surfaced and the load waits.
   */
  onLoadError?: (error: Error) => boolean | void;
  /** Release a result when it is replaced or the caller unmounts. */
  dispose?: (data: T) => void;
}

const EMPTY: { status: LoadStatus; data: null; error: null } = { status: 'loading', data: null, error: null };

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function useRetryable<T>(load: () => Promise<T>, deps: unknown[], options: RetryableOptions<T> = {}): RetryableLoad<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: LoadStatus; data: T | null; error: Error | null }>(EMPTY);

  // Read the latest load/options in the effect without making them deps: they
  // are recreated every render, and the caller's `deps` are what identify a load.
  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let loaded: T | null = null;

    const peeked = optionsRef.current.peek?.() ?? null;
    if (peeked !== null) {
      setState({ status: 'ready', data: peeked, error: null });
      return;
    }
    setState(EMPTY);

    (async () => {
      const attempts = Math.max(1, optionsRef.current.attempts ?? 1);
      let lastError: Error | null = null;

      for (let i = 0; i < attempts; i++) {
        if (i > 0) {
          const delays = optionsRef.current.retryDelaysMs ?? [];
          const delay = delays[Math.min(i - 1, delays.length - 1)] ?? 0;
          if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
        if (cancelled) return;
        try {
          const data = await loadRef.current();
          // A result that arrives after the deps changed (or after unmount)
          // is dropped — and its resources released, so a cancelled load
          // doesn't leak whatever it created (e.g. an object URL).
          if (cancelled) {
            optionsRef.current.dispose?.(data);
            return;
          }
          loaded = data;
          optionsRef.current.onLoaded?.(data);
          setState({ status: 'ready', data, error: null });
          return;
        } catch (err) {
          lastError = asError(err);
          if (optionsRef.current.onLoadError?.(lastError)) return;
        }
      }

      if (cancelled) return;
      setState({ status: 'error', data: null, error: lastError ?? new Error('Something went wrong.') });
    })();

    return () => {
      cancelled = true;
      if (loaded !== null) optionsRef.current.dispose?.(loaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status: state.status, data: state.data, error: state.error, retry };
}
