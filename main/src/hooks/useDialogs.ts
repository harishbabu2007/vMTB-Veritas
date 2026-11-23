import { useCallback, useRef, useState } from 'react';

/**
 * Dialog state, typed and exclusive.
 *
 * Pages used to hold one `useState(false)` per dialog (`showDeleteConfirm`,
 * `showArchiveConfirm`, `showAddToMtbModal`, …), so two dialogs could be open
 * at once and nothing said which one was meant to be showing. These two hooks
 * replace that: one value for "which dialog is open", and one action for
 * "confirm, then close when it's done".
 */

/**
 * Which dialog is open on this page, if any. `null` = none, so opening one
 * implicitly closes the others.
 */
export function useOpenDialog<T extends string>(initial: T | null = null) {
  const [open, setOpen] = useState<T | null>(initial);
  // Read by the stable helpers below, so a click-outside effect with an empty
  // dependency list can still close only the dialog it belongs to.
  const openRef = useRef(open);
  openRef.current = open;

  const isOpen = useCallback((id: T) => open === id, [open]);
  const show = useCallback((id: T) => setOpen(id), []);
  const close = useCallback(() => setOpen(null), []);
  const closeIfOpen = useCallback((id: T) => {
    if (openRef.current === id) setOpen(null);
  }, []);
  const toggle = useCallback((id: T) => setOpen((current) => (current === id ? null : id)), []);

  return { open, isOpen, show, close, closeIfOpen, toggle };
}

export interface ConfirmAction<A extends unknown[]> {
  /** The dialog is showing. */
  open: boolean;
  /** The action is running; its buttons should be disabled. */
  pending: boolean;
  /** Why the last attempt failed, if the action threw. */
  error: string | null;
  /** Open the dialog, optionally remembering arguments for `confirm`. */
  ask: (...args: A) => void;
  /** Close without running anything. Ignored while pending. */
  cancel: () => void;
  /** Run the action, then close. */
  confirm: () => Promise<void>;
}

export interface ConfirmActionOptions {
  /**
   * When to close the dialog: only if the action succeeded (default), or
   * always — for actions that navigate away on success, or that are already
   * terminal on failure.
   */
  closeOn?: 'success' | 'always';
}

/**
 * A confirm-then-do action whose "doing" flag cannot get stuck: `pending` is
 * held by the hook and always cleared in `finally`, so a thrown error can no
 * longer leave a button reading "Deleting…" forever.
 *
 * The action is responsible for its own messaging (toasts) and should rethrow
 * if the dialog should stay open for another attempt.
 */
export function useConfirmAction<A extends unknown[] = []>(
  run: (...args: A) => Promise<void>,
  options: ConfirmActionOptions = {}
): ConfirmAction<A> {
  const { closeOn = 'success' } = options;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const argsRef = useRef<A>([] as unknown as A);
  const pendingRef = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;

  const ask = useCallback((...args: A) => {
    argsRef.current = args;
    setError(null);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (pendingRef.current) return;
    setOpen(false);
    setError(null);
  }, []);

  const confirm = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await runRef.current(...argsRef.current);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      if (closeOn === 'always') setOpen(false);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [closeOn]);

  return { open, pending, error, ask, cancel, confirm };
}
