import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import {
  ALL_SAVED_KEYS,
  CASE_SECTION_GROUPS,
  OnboardingKey,
  TOUR_GROUPS,
  TOUR_GROUP_ORDER,
  TourActionName,
  TourGroupId,
} from '../onboarding/steps';

// Per-user walkthrough state. What's saved lives on profiles
// (onboarding_seen, onboarding_ended_at), so a finished or stopped part never
// comes back on another device or after the next login. Guided groups within
// a section are only remembered for this session (see steps.ts).
//
// Fails closed: until the profile row has been read successfully, nothing is
// shown. Missing a tour is better than showing one to an existing account.

type Status = 'idle' | 'loading' | 'ready' | 'missing' | 'unavailable';

// Aborted when the step goes away (the user skipped or left the screen).
type TourAction = (signal: AbortSignal) => Promise<void>;

interface OnboardingContextType {
  // The one group that may show right now, if any, and the step it starts at.
  activeGroup: TourGroupId | null;
  activeStart: number;
  requestGroup: (id: TourGroupId) => void;
  releaseGroup: (id: TourGroupId) => void;
  // Its target never appeared on this visit. Not marked seen, so it can show
  // on a later visit.
  deferGroup: (id: TourGroupId) => void;
  // The group was finished (or a tip closed).
  completeGroup: (id: TourGroupId) => void;
  // Saves keys directly, e.g. a section's milestone reached from a page.
  complete: (keys: OnboardingKey[]) => void;
  stopAll: () => void;
  // The walkthrough is loaded and still running for this user.
  walkthroughActive: boolean;
  hasSeen: (key: OnboardingKey) => boolean;
  // The case or MTB section is under way (its guided pages only make sense then).
  caseSectionRunning: boolean;
  mtbSectionRunning: boolean;
  // Restarts the case section's guided groups (the wizard draft was emptied).
  resetCaseSection: () => void;
  // A genuine restart of the whole walkthrough from Settings — unlike
  // everything else here, this un-marks keys that are already seen, for an
  // account that finished or skipped the tour long ago. Navigate to
  // /my-cases afterwards; that's where the welcome group's targets live.
  restartTour: () => Promise<void>;
  registerAction: (name: TourActionName, action: TourAction) => () => void;
  runAction: (name: TourActionName, signal: AbortSignal) => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

interface Pending {
  seen: OnboardingKey[];
  ended: boolean;
}

type Broadcast = { userId: string; type: 'seen'; key: OnboardingKey } | { userId: string; type: 'ended' };

const PENDING_PREFIX = 'vmtb.onboarding.pending.';
const CHANNEL = 'vmtb-onboarding';
const RETRY_MS = 2000;
const MISSING_RETRY_MS = 5000;

const readPending = (userId: string): Pending | null => {
  try {
    const raw = window.localStorage.getItem(PENDING_PREFIX + userId);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
};

const writePending = (userId: string, pending: Pending | null) => {
  try {
    if (pending) window.localStorage.setItem(PENDING_PREFIX + userId, JSON.stringify(pending));
    else window.localStorage.removeItem(PENDING_PREFIX + userId);
  } catch {
    // Storage unavailable: the in-memory state still holds for this session.
  }
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const openChannel = (): BroadcastChannel | null => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
};

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [status, setStatus] = useState<Status>('idle');
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [ended, setEnded] = useState(false);
  // Guided groups finished this session, and those that can show their
  // resume step because the user came back to their screen.
  const [sessionSeen, setSessionSeen] = useState<TourGroupId[]>([]);
  const [resumable, setResumable] = useState<TourGroupId[]>([]);
  const [requested, setRequested] = useState<TourGroupId[]>([]);
  const [deferred, setDeferred] = useState<TourGroupId[]>([]);
  const [active, setActive] = useState<{ id: TourGroupId; start: number } | null>(null);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const lastMissingFetch = useRef(0);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const sessionSeenRef = useRef(sessionSeen);
  sessionSeenRef.current = sessionSeen;
  const actionsRef = useRef(new Map<TourActionName, TourAction>());
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Runs a write once, retries once, and on a second failure tells the user
  // and keeps it for the next load instead of failing silently.
  const persist = useCallback(async (forUser: string, change: Pending, write: () => PromiseLike<{ error: unknown }>) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await write();
        if (!error) return;
      } catch {
        // Retried below.
      }
      if (attempt === 0) await wait(RETRY_MS);
    }
    const prev = readPending(forUser) ?? { seen: [], ended: false };
    writePending(forUser, {
      seen: Array.from(new Set([...prev.seen, ...change.seen])),
      ended: prev.ended || change.ended,
    });
    if (userIdRef.current === forUser) {
      showToast.error('Couldn’t save your walkthrough progress. It may show again next time.');
    }
  }, []);

  const writeSeen = useCallback((forUser: string, id: OnboardingKey) =>
    persist(forUser, { seen: [id], ended: false }, () => supabase.rpc('mark_onboarding_seen', { p_key: id })), [persist]);

  const writeEnded = useCallback((forUser: string) =>
    persist(forUser, { seen: [], ended: true }, () =>
      supabase.from('profiles').update({ onboarding_ended_at: new Date().toISOString() }).eq('id', forUser)), [persist]);

  // `quiet` re-reads (another tab, the page coming back into view) merge
  // with what this tab already knows instead of replacing it, so a write
  // still in flight can't make a finished part show again.
  const load = useCallback(async (forUser: string, quiet = false) => {
    // TEMPORARY (testing): restarts the walkthrough for a profile flagged
    // onboarding_test_restart, once per sign-in. Remove with migration
    // 20260919_onboarding_test_restart.sql.
    if (!quiet) await Promise.resolve(supabase.rpc('onboarding_test_restart_if_new_sign_in')).catch(() => undefined);

    const { data, error } = await supabase
      .from('profiles')
      .select('onboarding_seen, onboarding_ended_at')
      .eq('id', forUser)
      .maybeSingle();
    if (userIdRef.current !== forUser) return;
    if (error) {
      if (!quiet) setStatus('unavailable');
      return;
    }
    if (!data) {
      if (!quiet) setStatus('missing');
      return;
    }
    const row = data as { onboarding_seen: Record<string, string> | null; onboarding_ended_at: string | null };
    const serverSeen = row.onboarding_seen ?? {};
    let serverEnded = Boolean(row.onboarding_ended_at);

    // Replay anything a previous session couldn't save.
    const pending = readPending(forUser);
    const mergedSeen = quiet ? { ...serverSeen, ...seenRef.current } : { ...serverSeen };
    if (pending) {
      writePending(forUser, null);
      const now = new Date().toISOString();
      pending.seen.filter(id => !serverSeen[id]).forEach(id => {
        mergedSeen[id] = now;
        void writeSeen(forUser, id);
      });
      if (pending.ended && !serverEnded) {
        serverEnded = true;
        void writeEnded(forUser);
      }
    }
    seenRef.current = mergedSeen;
    setSeen(mergedSeen);
    setEnded(prev => (quiet ? prev || serverEnded : serverEnded));
    setStatus('ready');
  }, [writeSeen, writeEnded]);

  // Reset on login, logout and account switch.
  useEffect(() => {
    setSeen({});
    setEnded(false);
    setSessionSeen([]);
    setResumable([]);
    setDeferred([]);
    setActive(null);
    if (!userId) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    void load(userId);
  }, [userId, load]);

  // Other tabs: follow what they save or stop, and re-read when this tab
  // comes back into view.
  useEffect(() => {
    if (!userId) return;
    const channel = openChannel();
    channelRef.current = channel;
    const onMessage = (event: MessageEvent<Broadcast>) => {
      const msg = event.data;
      if (!msg || msg.userId !== userIdRef.current) return;
      if (msg.type === 'ended') {
        setEnded(true);
      } else if (!seenRef.current[msg.key]) {
        const next = { ...seenRef.current, [msg.key]: new Date().toISOString() };
        seenRef.current = next;
        setSeen(next);
      }
    };
    channel?.addEventListener('message', onMessage);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(userId, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      channel?.removeEventListener('message', onMessage);
      channel?.close();
      channelRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, load]);

  const broadcast = useCallback((msg: Broadcast) => {
    try {
      channelRef.current?.postMessage(msg);
    } catch {
      // Other tabs catch up when they're next shown.
    }
  }, []);

  // A just-created account can reach a tour screen before its profile row is
  // written (the client upserts it). Re-read when a screen asks for a tour.
  useEffect(() => {
    if (!userId || status !== 'missing' || requested.length === 0) return;
    if (Date.now() - lastMissingFetch.current < MISSING_RETRY_MS) return;
    lastMissingFetch.current = Date.now();
    void load(userId);
  }, [userId, status, requested, load]);

  const requestGroup = useCallback((id: TourGroupId) => {
    setRequested(prev => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const releaseGroup = useCallback((id: TourGroupId) => {
    setRequested(prev => prev.filter(g => g !== id));
    setDeferred(prev => prev.filter(g => g !== id));
    // Leaving the screen of a finished guided group: coming back to it
    // mid-section shows its resume step.
    if (TOUR_GROUPS[id].resumeStep !== undefined && sessionSeenRef.current.includes(id)) {
      setResumable(prev => (prev.includes(id) ? prev : [...prev, id]));
    }
  }, []);

  const deferGroup = useCallback((id: TourGroupId) => {
    setDeferred(prev => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const markSeen = useCallback((id: OnboardingKey) => {
    if (!userId || seenRef.current[id]) return;
    const next = { ...seenRef.current, [id]: new Date().toISOString() };
    seenRef.current = next;
    setSeen(next);
    void writeSeen(userId, id);
    broadcast({ userId, type: 'seen', key: id });
    // Everything seen: the walkthrough is over.
    if (ALL_SAVED_KEYS.every(k => next[k])) {
      setEnded(true);
      void writeEnded(userId);
    }
  }, [userId, writeSeen, writeEnded, broadcast]);

  const complete = useCallback((keys: OnboardingKey[]) => keys.forEach(markSeen), [markSeen]);

  const completeGroup = useCallback((id: TourGroupId) => {
    const group = TOUR_GROUPS[id];
    if (group.kind === 'tip') {
      markSeen(id);
    } else {
      const finished = [id, ...(group.alsoFinishes ?? [])];
      const next = [...sessionSeenRef.current, ...finished.filter(g => !sessionSeenRef.current.includes(g))];
      sessionSeenRef.current = next;
      setSessionSeen(next);
      setResumable(prev => prev.filter(g => !finished.includes(g)));
    }
    group.completes?.forEach(markSeen);
  }, [markSeen]);

  const resetCaseSection = useCallback(() => {
    const next = sessionSeenRef.current.filter(g => !CASE_SECTION_GROUPS.includes(g));
    sessionSeenRef.current = next;
    setSessionSeen(next);
    setResumable(prev => prev.filter(g => !CASE_SECTION_GROUPS.includes(g)));
  }, []);

  // Every other write here only ever adds a key; this is the one place that
  // clears them, so a finished or skipped walkthrough can genuinely run
  // again — not just re-trigger something gated on "not yet seen".
  const restartTour = useCallback(async () => {
    if (!userId) return;
    writePending(userId, null);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ onboarding_seen: {}, onboarding_ended_at: null })
        .eq('id', userId);
      if (error) throw error;
    } catch {
      showToast.error('Couldn’t restart the tour. Please try again.');
      return;
    }
    seenRef.current = {};
    setSeen({});
    setEnded(false);
    sessionSeenRef.current = [];
    setSessionSeen([]);
    setResumable([]);
    setDeferred([]);
  }, [userId]);

  const hasSeen = useCallback((key: OnboardingKey) => Boolean(seen[key]), [seen]);
  const walkthroughActive = status === 'ready' && !ended;
  const caseSectionRunning = walkthroughActive && Boolean(seen.welcome) && !seen.case_flow;
  const mtbSectionRunning = walkthroughActive && Boolean(seen.case_flow) && !seen.mtb_flow;

  const stopAll = useCallback(() => {
    if (!userId) return;
    setEnded(true);
    void writeEnded(userId);
    broadcast({ userId, type: 'ended' });
  }, [userId, writeEnded, broadcast]);

  const registerAction = useCallback((name: TourActionName, action: TourAction) => {
    actionsRef.current.set(name, action);
    return () => {
      if (actionsRef.current.get(name) === action) actionsRef.current.delete(name);
    };
  }, []);

  const runAction = useCallback(async (name: TourActionName, signal: AbortSignal) => {
    const action = actionsRef.current.get(name);
    if (!action) throw new Error(`Tour action "${name}" isn't available here`);
    await action(signal);
  }, []);

  // Pick the group to show. One at a time; everything waits for the welcome.
  // A running group keeps going until it ends or its screen goes away.
  useEffect(() => {
    const startFor = (id: TourGroupId): number | null => {
      if (status !== 'ready' || ended || !requested.includes(id) || deferred.includes(id)) return null;
      const group = TOUR_GROUPS[id];
      if (id !== 'welcome' && !seen.welcome) return null;
      if (group.requires?.some(k => !seen[k])) return null;
      if (group.blockedBy?.some(k => seen[k])) return null;
      if (group.kind === 'tip') return seen[id] ? null : 0;
      if (id === 'welcome') return seen.welcome ? null : 0;
      if (!sessionSeen.includes(id)) return 0;
      return resumable.includes(id) && group.resumeStep !== undefined ? group.resumeStep : null;
    };
    setActive(current => {
      if (current && startFor(current.id) !== null) return current;
      for (const id of TOUR_GROUP_ORDER) {
        const start = startFor(id);
        if (start !== null) return { id, start };
      }
      return null;
    });
  }, [status, ended, seen, sessionSeen, resumable, requested, deferred]);

  const value = useMemo(
    () => ({
      activeGroup: active?.id ?? null,
      activeStart: active?.start ?? 0,
      requestGroup,
      releaseGroup,
      deferGroup,
      completeGroup,
      complete,
      stopAll,
      walkthroughActive,
      hasSeen,
      caseSectionRunning,
      mtbSectionRunning,
      resetCaseSection,
      restartTour,
      registerAction,
      runAction,
    }),
    [active, requestGroup, releaseGroup, deferGroup, completeGroup, complete, stopAll, walkthroughActive, hasSeen,
      caseSectionRunning, mtbSectionRunning, resetCaseSection, restartTour, registerAction, runAction]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (context === undefined) throw new Error('useOnboarding must be used within an OnboardingProvider');
  return context;
}
