import { useEffect, useRef } from 'react';
import { useOnboarding } from '../context/OnboardingContext';
import type { TourActionName, TourGroupId } from '../onboarding/steps';

// Lets a screen offer its walkthrough tip group once the screen is ready
// (data loaded, the controls it points at rendered). Whether it actually
// shows is decided by OnboardingContext.
export function useTourGroup(id: TourGroupId, ready: boolean) {
  const { requestGroup, releaseGroup } = useOnboarding();
  useEffect(() => {
    if (!ready) return;
    requestGroup(id);
    return () => releaseGroup(id);
  }, [id, ready, requestGroup, releaseGroup]);
}

// Lets a screen provide something a walkthrough step's button does (e.g.
// dropping in the sample report). The latest `action` is always the one run.
export function useTourAction(name: TourActionName, action: (signal: AbortSignal) => Promise<void>) {
  const { registerAction } = useOnboarding();
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => registerAction(name, signal => actionRef.current(signal)), [name, registerAction]);
}
