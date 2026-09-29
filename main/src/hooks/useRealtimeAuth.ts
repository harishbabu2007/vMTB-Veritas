import { useEffect, useState } from 'react';
import { supabase } from '../Supabase/client';

// Realtime authenticates separately from the REST client, and it does so once:
// a channel keeps whatever claims it joined with for its entire life. Nothing
// pushes the session onto the socket automatically here, so a channel that
// subscribes before the access token arrives joins as `anon` -- and then, for
// an RLS-enabled table, auth.uid() is NULL inside every policy, the server
// matches no rows, and it delivers nothing. Silently, and permanently for that
// channel.
//
// That is a race against session restore, so it lands differently on different
// page loads, which is what makes it look intermittent ("worked once, then
// never again") rather than broken. It also hides itself: an RLS-*disabled*
// table like `cases` keeps delivering with null claims, so whichever
// subscriptions happen to be on open tables look fine while the RLS-protected
// ones are dead. Confirmed against realtime.subscription on the live project,
// which recorded `user_id NULL` rows for mtb_cases/mtbs (2026-09-29).
//
// Fix: stamp the token on the socket as soon as there is one, and hand the
// token back to callers so a subscription can wait for it and re-subscribe
// when it changes (a refresh gives the channel fresh claims, and Realtime
// rejects an expired JWT).

let currentToken: string | null = null;
let started = false;
const listeners = new Set<(token: string | null) => void>();

function apply(token: string | null) {
  if (token === currentToken) return;
  currentToken = token;
  // setAuth is what stamps the JWT onto the socket for every later join.
  if (token) void supabase.realtime.setAuth(token);
  listeners.forEach(notify => notify(token));
}

// One listener for the whole app rather than one per subscribing component.
function start() {
  if (started) return;
  started = true;
  void supabase.auth.getSession().then(({ data }) => apply(data.session?.access_token ?? null));
  supabase.auth.onAuthStateChange((_event, session) => apply(session?.access_token ?? null));
}

/**
 * The access token currently stamped on the Realtime socket, or null if there
 * isn't one yet. Gate every `postgres_changes` subscription on this being
 * non-null and include it in the effect's deps: that way a channel is never
 * created before the socket can authenticate it, and it is rebuilt with fresh
 * claims when the token is refreshed.
 */
export function useRealtimeAuthToken(): string | null {
  const [token, setToken] = useState<string | null>(currentToken);
  useEffect(() => {
    start();
    listeners.add(setToken);
    // A token may have arrived between render and this effect running.
    setToken(currentToken);
    return () => { listeners.delete(setToken); };
  }, []);
  return token;
}
