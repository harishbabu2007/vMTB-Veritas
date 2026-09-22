import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { supabase } from '../Supabase/client';
import { THEME_CACHE_PREFIX } from '../utils/themeStorage';

type AuthUser = { id: string; email: string | null; name?: string; avatarKey?: string | null };

// 'unknown' while the profile row hasn't been checked yet for the current
// session (a brief window right after sign-in, or at app boot). Route
// gates (App.tsx) must treat 'unknown' like `loading` -- not "complete" --
// or an abandoned Google signup (a real Supabase session with no finished
// `profiles` row) would slip straight into the app before the check lands.
type RegistrationStatus = 'unknown' | 'complete' | 'incomplete';

interface AuthContextType {
  isAuthenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  isInPasswordRecovery: boolean;
  // null = still checking (treat like `loading`); false = signed in but
  // registration (WhatsApp verification) never finished.
  registrationComplete: boolean | null;
  markRegistrationComplete: () => void;
  updateAvatarKey: (avatarKey: string | null) => void;
  login: (email: string, password: string) => Promise<void>;
  loginWithPhone: (countryCode: string, phoneNumber: string, password: string) => Promise<void>;
  sendPhoneOtp: (countryCode: string, phoneNumber: string) => Promise<void>;
  verifyPhoneOtp: (countryCode: string, phoneNumber: string, otpCode: string) => Promise<void>;
  signInWithGoogle: (flow?: 'login' | 'signup') => Promise<void>;
  signup: (params: {
    name: string;
    email: string;
    password: string;
    profession?: string;
    hospital?: string;
    whatsappNumber?: string;
  }) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Storage key for user info only
const AUTH_USER_STORAGE_KEY = 'vmtb.auth.user';

const canUseStorage = () => typeof window !== 'undefined' && !!window.localStorage;

const storeUser = (user: AuthUser | null) => {
  if (!canUseStorage()) return;
  if (!user) {
    window.localStorage.removeItem(AUTH_USER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
};

const readStoredUser = (): AuthUser | null => {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(AUTH_USER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch (_err) {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInPasswordRecovery, setIsInPasswordRecovery] = useState(false);
  const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatus>('unknown');
  const isAuthenticated = !!user;
  const registrationComplete = registrationStatus === 'unknown' ? null : registrationStatus === 'complete';
  // Which user id `registrationStatus` currently reflects, so a stale
  // status from a previous user can't briefly apply to a newly-signed-in
  // one before its own check resolves.
  const registrationUserIdRef = useRef<string | null>(null);

  // Auth events (TOKEN_REFRESHED, a repeated SIGNED_IN, another tab's storage
  // write) re-deliver the same user. Keep the existing object in that case so
  // everything keyed on `user` doesn't treat it as a new login and refetch.
  // The event payload usually lacks the profile name, so keep the one already
  // loaded rather than blanking it.
  const setUserIfChanged = (next: AuthUser | null) => {
    setUser(prev => {
      if (!next) return prev === null ? prev : null;
      if (!prev || prev.id !== next.id) return next;
      const merged = { ...next, name: next.name ?? prev.name, avatarKey: next.avatarKey ?? prev.avatarKey };
      return prev.email === merged.email && prev.name === merged.name && prev.avatarKey === merged.avatarKey ? prev : merged;
    });
  };

  const updateAvatarKey = (avatarKey: string | null) => {
    setUser(prev => (prev ? { ...prev, avatarKey } : prev));
  };

  const backfillProfileFromMetadata = async (id: string) => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const meta = (authData.user as any)?.user_metadata || {};
      const fullName = meta.name as string | undefined;
      const profession = meta.profession as string | undefined;
      const hospital = meta.hospital as string | undefined;
      const whatsappNumber = meta.whatsappNumber as string | undefined;

      if (!fullName && !profession && !hospital && !whatsappNumber) return;

      await supabase.from('profiles').upsert({
        id,
        full_name: fullName,
        profession,
        hospital,
        whatsapp_number: whatsappNumber,
      }, { onConflict: 'id' });

      if (fullName) {
        setUser(prev => (prev && prev.name !== fullName ? { ...prev, name: fullName } : prev));
      }
    } catch (_err) {
      // Ignore failures; do not block auth flow
    }
  };

  // Same round trip the old name-only fetch already made; now also decides
  // whether registration (WhatsApp verification) is complete for this
  // session, from the one server-set `whatsapp_verified` column -- not
  // from whether a `profiles` row merely exists (backfillProfileFromMetadata
  // below can create a bare row, e.g. from a Google account's display name,
  // for a signup that was never actually finished).
  const loadProfile = async (id: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('full_name, avatar_key, whatsapp_verified')
        .eq('id', id)
        .single();
      const profile = data as { full_name?: string; avatar_key?: string | null; whatsapp_verified?: boolean | null } | null;
      if (error || !profile) {
        setRegistrationStatus('incomplete');
        await backfillProfileFromMetadata(id);
        return;
      }
      const name = profile.full_name;
      if (name) {
        setUser(prev =>
          prev && (prev.name !== name || prev.avatarKey !== profile.avatar_key)
            ? { ...prev, name, avatarKey: profile.avatar_key ?? null }
            : prev
        );
      } else {
        await backfillProfileFromMetadata(id);
      }
      setRegistrationStatus(profile.whatsapp_verified ? 'complete' : 'incomplete');
    } catch (_err) {
      // Ignore missing profile; keep auth working without name
      setRegistrationStatus('incomplete');
      await backfillProfileFromMetadata(id);
    }
  };

  // Wraps loadProfile so a status left over from a different user (or from
  // this same user's previous session) can't be read as this session's
  // answer while the fresh check is still in flight.
  const beginProfileLoad = (id: string) => {
    if (registrationUserIdRef.current !== id) {
      registrationUserIdRef.current = id;
      setRegistrationStatus('unknown');
    }
    return loadProfile(id);
  };

  const markRegistrationComplete = () => setRegistrationStatus('complete');

  useEffect(() => {
    // Check if we're on reset-password page with a hash (recovery link)
    const isOnResetPasswordWithHash = 
      typeof window !== 'undefined' && 
      window.location.pathname === '/reset-password' && 
      window.location.hash.includes('access_token');

    // Load cached user immediately to avoid flicker while Supabase initializes
    // BUT skip if on reset-password with hash to avoid race condition
    if (!isOnResetPasswordWithHash) {
      const cachedUser = readStoredUser();
      if (cachedUser) {
        setUser(cachedUser);
      }
    }

    let initialSessionHandled = false;

    // Subscribe to auth state changes - this handles initial session load AND subsequent changes
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[AUTH] State change:', event, session?.user?.email);
      
      // Track PASSWORD_RECOVERY event specifically
      if (event === 'PASSWORD_RECOVERY') {
        console.log('[AUTH] Password recovery mode detected');
        setIsInPasswordRecovery(true);
      } else if (event === 'SIGNED_OUT') {
        // Reset recovery flag when user signs out
        setIsInPasswordRecovery(false);
      }
      
      const u = session?.user;
      if (u) {
        const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
        setUserIfChanged(userData);
        storeUser(userData);
        // Fire-and-forget profile fetch (name + registration status)
        beginProfileLoad(u.id);
      } else {
        setUserIfChanged(null);
        storeUser(null);
        registrationUserIdRef.current = null;
        setRegistrationStatus('unknown');
      }
      
      // Set loading false after initial session check
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        if (!initialSessionHandled) {
          initialSessionHandled = true;
          setLoading(false);
        }
      }
    });

    // Fallback: If INITIAL_SESSION doesn't fire within 2 seconds, set loading false
    const fallbackTimeout = setTimeout(() => {
      if (!initialSessionHandled) {
        console.log('[AUTH] Fallback: Setting loading false');
        initialSessionHandled = true;
        setLoading(false);
      }
    }, 2000);

    // Listen for user info changes from other tabs
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === AUTH_USER_STORAGE_KEY) {
        const newUser = readStoredUser();
        setUserIfChanged(newUser);
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      clearTimeout(fallbackTimeout);
      authSub.subscription.unsubscribe();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const login = async (email: string, password: string) => {
    const { error, data } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      // Fire-and-forget profile name fetch to avoid blocking UI
      beginProfileLoad(u.id);
    }
  };

  const loginWithPhone = async (countryCode: string, phoneNumber: string, password: string) => {
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const fullPhone = `${cleanCountryCode}${cleanPhoneNumber}`;
    
    console.log('[AUTH] Logging in with phone:', fullPhone);
    
    // Step 1: Look up account profile by whatsapp_number (selecting ONLY existing 'id' column)
    const { data: profiles, error: profileErr } = await supabase
      .from('profiles')
      .select('id')
      .or(`whatsapp_number.eq.${fullPhone},whatsapp_number.eq.${cleanPhoneNumber}`);

    if (profileErr || !profiles || profiles.length === 0) {
      console.error('[AUTH] Profile lookup failed:', profileErr);
      throw new Error('Invalid credentials');
    }

    const userId = profiles[0].id;

    // Step 2: Retrieve user's primary email from Supabase Auth via Edge Function
    const { data: edgeData, error: edgeErr } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: { action: 'get_email', user_id: userId, phone: fullPhone, otp: '000000' }
    });

    if (edgeErr || !edgeData?.email) {
      console.error('[AUTH] Failed to fetch email from Auth:', edgeErr);
      throw new Error('Invalid credentials');
    }

    const userEmail = edgeData.email;

    // Step 3: Authenticate with Supabase Auth using email & entered password
    const { error, data } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: password,
    });

    if (error) {
      if (error.message.includes('Invalid login credentials')) {
        throw new Error('Invalid credentials');
      }
      throw error;
    }

    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      beginProfileLoad(u.id);
    }
  };

  const sendPhoneOtp = async (countryCode: string, phoneNumber: string) => {
    // Construct E.164 format phone number (with +)
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const phoneE164 = `+${cleanCountryCode}${cleanPhoneNumber}`;
    
    console.log('[DEBUG] Sending OTP to:', phoneE164);
    
    const { error } = await supabase.auth.signInWithOtp({ 
      phone: phoneE164 
    });
    if (error) throw error;
  };

  const verifyPhoneOtp = async (countryCode: string, phoneNumber: string, otpCode: string) => {
    // Construct E.164 format phone number (with +)
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const phoneE164 = `+${cleanCountryCode}${cleanPhoneNumber}`;
    
    console.log('[DEBUG] Verifying OTP for:', phoneE164);
    
    const { error, data } = await supabase.auth.verifyOtp({ 
      phone: phoneE164,
      token: otpCode,
      type: 'sms'
    });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      // Fire-and-forget profile name fetch to avoid blocking UI
      beginProfileLoad(u.id);
    }
  };

  const signInWithGoogle = async (flow: 'login' | 'signup' = 'login') => {
    const redirectUrl = `${window.location.origin}/auth/callback${flow === 'signup' ? '?flow=signup' : ''}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
      },
    });
    if (error) throw error;
  };

  const signup = async ({ name, email, password, profession, hospital, whatsappNumber }: {
    name: string; email: string; password: string; profession?: string; hospital?: string; whatsappNumber?: string;
  }) => {
    const { error, data } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, profession, hospital, whatsappNumber },
      },
    });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name };
      setUser(userData);
      storeUser(userData);
      // Create profile record
      await supabase.from('profiles').upsert({
        id: u.id,
        full_name: name,
        profession,
        hospital,
        whatsapp_number: whatsappNumber,
      }, { onConflict: 'id' });
    }
  };

  const requestPasswordReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password',
    });
    if (error) throw error;
  };

  const logout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error('[AUTH] Error during supabase.auth.signOut():', err);
    } finally {
      setUser(null);
      storeUser(null);
      setIsInPasswordRecovery(false);
      registrationUserIdRef.current = null;
      setRegistrationStatus('unknown');
      if (canUseStorage()) {
        window.localStorage.removeItem(AUTH_USER_STORAGE_KEY);
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const key = window.localStorage.key(i);
          // Per-user theme hints stay: they're keyed by user id, so they can't
          // reach another person, and keeping them stops the returning user's
          // theme flashing light while their profile loads.
          if (key && !key.startsWith(THEME_CACHE_PREFIX) && (key.startsWith('sb-') || key.includes('supabase') || key.includes('vmtb'))) {
            window.localStorage.removeItem(key);
          }
        }
      }
    }
  };

  const value = useMemo(() => ({ isAuthenticated, user, loading, isInPasswordRecovery, registrationComplete, markRegistrationComplete, updateAvatarKey, login, loginWithPhone, sendPhoneOtp, verifyPhoneOtp, signInWithGoogle, signup, requestPasswordReset, logout }), [isAuthenticated, user, loading, isInPasswordRecovery, registrationComplete]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
