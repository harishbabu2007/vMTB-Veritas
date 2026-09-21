// Pre-hydration theme cache, shared by ThemeContext and mirrored (by hand) in
// the inline script in index.html — keep the three in agreement.
//
// It is only a *hint* so the first paint is right before React and the profile
// fetch arrive; `profiles.theme_preference` is the source of truth. The hint is
// keyed by user id so one person's theme can never be applied to another on a
// shared computer, and nothing is read for a visitor with no stored user.

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// A visitor with no saved choice always gets light, whatever their OS says.
export const DEFAULT_THEME: Theme = 'light';

export const THEME_CACHE_PREFIX = 'vmtb-theme:';
const LEGACY_GLOBAL_KEY = 'vmtb-theme-last';
// AuthContext's cached-user key; its `id` says whose hint to read.
const AUTH_USER_KEY = 'vmtb.auth.user';

export const themeCacheKey = (userId: string) => `${THEME_CACHE_PREFIX}${userId}`;

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readStoredUserId(): string | null {
  try {
    const raw = window.localStorage.getItem(AUTH_USER_KEY);
    const id = raw ? (JSON.parse(raw) as { id?: unknown } | null)?.id : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export function readCachedTheme(userId: string): Theme | null {
  try {
    const cached = window.localStorage.getItem(themeCacheKey(userId));
    return isTheme(cached) ? cached : null;
  } catch {
    return null;
  }
}

/** `null` removes the hint (the account has no saved choice). */
export function writeCachedTheme(userId: string, theme: Theme | null) {
  try {
    if (theme) window.localStorage.setItem(themeCacheKey(userId), theme);
    else window.localStorage.removeItem(themeCacheKey(userId));
  } catch {
    // Storage blocked or full: the hint is optional.
  }
}

/** Drops the old single global key, which leaked one user's theme to the next. */
export function clearLegacyThemeCache() {
  try {
    window.localStorage.removeItem(LEGACY_GLOBAL_KEY);
  } catch {
    // ignore
  }
}

/** The theme this browser should paint first: the stored user's hint, else light. */
export function readInitialTheme(): { userId: string | null; theme: Theme } {
  const userId = readStoredUserId();
  return { userId, theme: (userId && readCachedTheme(userId)) || DEFAULT_THEME };
}
