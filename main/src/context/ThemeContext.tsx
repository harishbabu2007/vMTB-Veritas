import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../Supabase/client';

type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_CACHE_KEY = 'vmtb-theme-last';

function getSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

function readCache(): Theme {
  try {
    const cached = window.localStorage.getItem(THEME_CACHE_KEY);
    if (cached === 'light' || cached === 'dark' || cached === 'system') return cached;
  } catch (_err) {
    // ignore
  }
  return 'system';
}

function writeCache(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch (_err) {
    // ignore
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [theme, setThemeState] = useState<Theme>(() => readCache());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === 'system' ? getSystemPreference() : theme
  );
  const prevUserId = useRef<string | undefined>(user?.id);

  // Apply + persist to the pre-hydration cache whenever the theme changes.
  useEffect(() => {
    const resolved = theme === 'system' ? getSystemPreference() : theme;
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
    writeCache(theme);
  }, [theme]);

  // While following the OS, live-update if the OS preference changes.
  useEffect(() => {
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const resolved = getSystemPreference();
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Once the logged-in user is known, reconcile with their saved preference
  // (source of truth once loaded — corrects a wrong pre-hydration guess, e.g.
  // on a shared computer or a new device with no local cache yet).
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('theme_preference')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        const saved = (data as { theme_preference?: string | null } | null)?.theme_preference;
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setThemeState(saved);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // On logout, don't let this user's theme leak to the next person on a
  // shared computer — reset to following the OS preference.
  useEffect(() => {
    if (prevUserId.current && !user?.id) {
      setThemeState('system');
    }
    prevUserId.current = user?.id;
  }, [user?.id]);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    if (user?.id) {
      supabase.from('profiles').update({ theme_preference: next }).eq('id', user.id);
    }
  };

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, user?.id]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
