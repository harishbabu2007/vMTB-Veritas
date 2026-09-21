import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import {
  DEFAULT_THEME,
  clearLegacyThemeCache,
  isTheme,
  readCachedTheme,
  readInitialTheme,
  resolveTheme,
  themeCacheKey,
  writeCachedTheme,
  type ResolvedTheme,
  type Theme,
} from '../utils/themeStorage';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

/**
 * Writes the user's choice to their own profiles row. Resolves false when it
 * did not land, so the caller can tell the user instead of letting them believe
 * it saved. (The query builder is lazy: nothing is sent unless it is awaited.)
 */
async function persistTheme(userId: string, next: Theme): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ theme_preference: next })
    .eq('id', userId)
    .select('id');
  if (error) {
    console.error('[THEME] Saving theme preference failed:', error.message);
    return false;
  }
  if (data && data.length > 0) return true;

  // No row matched: the profile row isn't there yet (a brand-new signup that is
  // still being written). Create it; AuthContext's own upsert only sets the
  // columns it names, so it won't clobber this one.
  const { error: upsertError } = await supabase
    .from('profiles')
    .upsert({ id: userId, theme_preference: next }, { onConflict: 'id' });
  if (upsertError) {
    console.error('[THEME] Creating profile for theme preference failed:', upsertError.message);
    return false;
  }
  return true;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;

  // Same source the inline script in index.html used for the first paint, so
  // the first render agrees with what is already on screen.
  const [initial] = useState(readInitialTheme);
  const [theme, setThemeState] = useState<Theme>(initial.theme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(initial.theme));

  // Whose theme `theme` currently is (null = nobody signed in).
  const ownerRef = useRef<string | null>(initial.userId);
  // Bumped by every user choice and identity change. A profile fetch or failed
  // save that started before the bump is stale and must not overwrite state.
  const choiceSeq = useRef(0);
  // The last value known to be on the server; a failed save reverts to it.
  const lastSaved = useRef<Theme>(initial.theme);
  // Saves run one at a time, in order, so the last choice is what ends up stored.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    clearLegacyThemeCache();
  }, []);

  // Apply the theme to the document.
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, [theme]);

  // While following the OS, live-update if the OS preference changes.
  useEffect(() => {
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const resolved = resolveTheme('system');
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Follow the signed-in identity. On a change of person (login, logout, another
  // tab signing in as someone else) drop the previous person's theme at once.
  useEffect(() => {
    // Auth hasn't decided yet: keep the pre-hydration paint, don't flash light.
    if (!userId && authLoading) return;
    if (ownerRef.current === userId) return;
    ownerRef.current = userId;
    choiceSeq.current += 1;
    const next = (userId && readCachedTheme(userId)) || DEFAULT_THEME;
    lastSaved.current = next;
    setThemeState(next);
  }, [userId, authLoading]);

  // Reconcile with this user's saved preference: the source of truth, which
  // corrects a stale or missing hint (new device, cleared storage).
  useEffect(() => {
    if (!userId) return;
    const seq = choiceSeq.current;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('theme_preference')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        // Stale: this user changed theme (or the identity changed) meanwhile,
        // and their fresh choice must win over what we read.
        if (cancelled || seq !== choiceSeq.current) return;
        if (error) {
          console.warn('[THEME] Could not read saved theme preference:', error.message);
          return; // keep the cached hint
        }
        const saved = (data as { theme_preference?: string | null } | null)?.theme_preference;
        // NULL = never chosen -> light. Don't cache that: it isn't a choice.
        const next = isTheme(saved) ? saved : DEFAULT_THEME;
        lastSaved.current = next;
        writeCachedTheme(userId, isTheme(saved) ? saved : null);
        setThemeState(next);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Another tab changed this user's theme: follow it (it writes the hint after
  // its own choice, and again if its save failed and it reverted).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const owner = ownerRef.current;
      if (!owner || e.key !== themeCacheKey(owner)) return;
      const next = isTheme(e.newValue) ? e.newValue : DEFAULT_THEME;
      choiceSeq.current += 1;
      lastSaved.current = next;
      setThemeState(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback(
    (next: Theme) => {
      if (!isTheme(next) || next === theme) return;
      const owner = ownerRef.current;
      const seq = ++choiceSeq.current;
      setThemeState(next);
      if (!owner) return; // signed out: nobody to save it for

      writeCachedTheme(owner, next);
      saveQueue.current = saveQueue.current.then(async () => {
        const saved = await persistTheme(owner, next).catch(() => false);
        if (saved) {
          lastSaved.current = next;
          return;
        }
        // Only the latest choice by this same user is reverted; an older one
        // that failed is superseded by whatever came after it.
        if (seq !== choiceSeq.current || ownerRef.current !== owner) return;
        setThemeState(lastSaved.current);
        writeCachedTheme(owner, lastSaved.current === DEFAULT_THEME ? null : lastSaved.current);
        showToast.error("Couldn't save your theme. It has been set back to your saved one.");
      });
    },
    [theme]
  );

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
