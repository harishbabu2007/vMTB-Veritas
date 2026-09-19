import { useEffect, useState, useCallback } from 'react';
import { getProfilePhotoViewUrl } from '../services/profilePhoto';

const REFRESH_BEFORE_EXPIRY_MS = 800_000; // presigned GET URLs are valid ~900s

interface CacheEntry {
  url: string;
  fetchedAt: number;
}

// Shared across every mounted avatar (navbar, modal, mobile drawer) so they
// don't each independently re-request a presigned URL for the same key.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

async function resolve(avatarKey: string): Promise<string> {
  const cached = cache.get(avatarKey);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_BEFORE_EXPIRY_MS) {
    return cached.url;
  }

  let pending = inFlight.get(avatarKey);
  if (!pending) {
    pending = getProfilePhotoViewUrl(avatarKey).finally(() => inFlight.delete(avatarKey));
    inFlight.set(avatarKey, pending);
  }

  const url = await pending;
  cache.set(avatarKey, { url, fetchedAt: Date.now() });
  return url;
}

/**
 * Resolves a real photo URL for a stored profiles.avatar_key, refreshing it
 * before the underlying presigned URL expires. Returns null while there's no
 * key (render the initials fallback) or while loading.
 */
export function useAvatarUrl(avatarKey: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(() => (avatarKey ? cache.get(avatarKey)?.url ?? null : null));

  useEffect(() => {
    if (!avatarKey) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    resolve(avatarKey)
      .then((resolvedUrl) => {
        if (!cancelled) setUrl(resolvedUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [avatarKey]);

  const retry = useCallback(() => {
    if (!avatarKey) return;
    cache.delete(avatarKey);
    resolve(avatarKey)
      .then(setUrl)
      .catch(() => setUrl(null));
  }, [avatarKey]);

  return { url, retry };
}
