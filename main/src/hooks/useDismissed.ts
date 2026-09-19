import { useCallback, useEffect, useState } from 'react';

// Remembers that the user closed a specific notice. The key should identify
// the exact occurrence (e.g. the run or summary version it's about), so a new
// occurrence shows again while a closed one stays closed across revisits.
// Stored under a `vmtb.` prefix, which logout clears. Storage can be
// unavailable (private mode, blocked site data); then it only lasts until the
// page is reloaded.
const PREFIX = 'vmtb.dismissed.';
const EVENT = 'vmtb-dismissed';

const read = (key: string): boolean => {
  try {
    return window.localStorage.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
};

export function useDismissed(key: string | null): [boolean, () => void] {
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());

  // Another mounted copy of the same notice (e.g. the case update banner on
  // both the Summary and Reports tabs) closes too.
  useEffect(() => {
    const onDismissed = (e: Event) => {
      const dismissedKey = (e as CustomEvent<string>).detail;
      setDismissedKeys(prev => (prev.has(dismissedKey) ? prev : new Set(prev).add(dismissedKey)));
    };
    window.addEventListener(EVENT, onDismissed);
    return () => window.removeEventListener(EVENT, onDismissed);
  }, []);

  const dismissed = key !== null && (dismissedKeys.has(key) || read(key));

  const dismiss = useCallback(() => {
    if (key === null) return;
    try {
      window.localStorage.setItem(PREFIX + key, '1');
    } catch {
      // Keep it closed for this page view only.
    }
    setDismissedKeys(prev => new Set(prev).add(key));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  }, [key]);

  return [dismissed, dismiss];
}
