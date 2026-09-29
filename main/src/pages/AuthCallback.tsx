import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../Supabase/client';

/**
 * AuthCallback handles the Google OAuth redirect.
 * After Google authenticates, Supabase redirects here.
 *
 * Logic:
 * - Registration is only complete once `profiles.whatsapp_verified` is true
 *   (a bare `profiles` row can exist for an abandoned signup — see
 *   AuthContext.loadProfile). This check runs regardless of whether the
 *   user arrived via the login button or the signup button (?flow=signup),
 *   so an already-registered account can never be routed back to the
 *   signup form just because "Sign up" was clicked instead of "Log in".
 * - Already registered → dashboard.
 * - Not yet registered → signup form, with Google email/id in state.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('Authenticating...');

  useEffect(() => {
    const handleCallback = async () => {
      try {
        // Wait for Supabase to process the OAuth tokens from the URL hash
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          console.error('[AuthCallback] Session error:', sessionError);
          setStatus('Authentication failed. Redirecting...');
          setTimeout(() => navigate('/login'), 2000);
          return;
        }

        const session = sessionData.session;

        if (!session?.user) {
          // No session yet, wait for auth state change
          setStatus('Processing authentication...');
          
          // Listen for the session to appear
          const { data: authSub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
            if (event === 'SIGNED_IN' && newSession?.user) {
              authSub.subscription.unsubscribe();
              await processUser(newSession.user);
            }
          });

          // Fallback timeout
          setTimeout(() => {
            authSub.subscription.unsubscribe();
            setStatus('Authentication timed out. Redirecting...');
            navigate('/login');
          }, 10000);
          return;
        }

        await processUser(session.user);
      } catch (err) {
        console.error('[AuthCallback] Error:', err);
        setStatus('Something went wrong. Redirecting...');
        setTimeout(() => navigate('/login'), 2000);
      }
    };

    const processUser = async (user: any) => {
      const googleEmail = user.email;
      const googleUserId = user.id;
      const googleName = user.user_metadata?.full_name || user.user_metadata?.name || '';

      if (!googleEmail) {
        setStatus('Could not retrieve email from Google. Redirecting...');
        setTimeout(() => navigate('/login'), 2000);
        return;
      }

      // A user is "registered" iff whatsapp_verified is true — the same
      // definition AuthContext.loadProfile uses. This runs no matter which
      // button (Login or Sign up) sent the user through Google OAuth, so a
      // fully registered account is always sent to the dashboard, never
      // back to the signup form.
      setStatus('Checking your account...');

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, whatsapp_verified')
        .eq('id', googleUserId)
        .single();

      const alreadyRegistered = !profileError && !!profile?.whatsapp_verified;

      if (alreadyRegistered) {
        setStatus('Welcome back! Redirecting...');
        // Not a hardcoded '/my-cases' -- AuthRedirect waits for AuthContext's
        // own role load (already in flight from the auth-state-change
        // handler) and sends this account to its own role-appropriate home.
        navigate('/', { replace: true });
        return;
      }

      // No profile row, or a profile row exists but signup was never
      // finished → send them to complete signup.
      setStatus('Setting up your account...');
      navigate('/signup', {
        state: {
          googleEmail,
          googleUserId,
          googleName,
          googleAuthenticated: true,
        },
        replace: true,
      });
    };

    handleCallback();
  }, [navigate]);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          <div className="text-center">
            {/* Loading spinner */}
            <div className="inline-flex items-center justify-center mb-6">
              <div
                className="w-10 h-10 border-4 border-border rounded-full animate-spin"
                style={{ borderTopColor: 'var(--color-primary)' }}
              />
            </div>
            <p className="text-text-muted">{status}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
