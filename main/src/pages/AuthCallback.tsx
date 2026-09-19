import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../Supabase/client';

/**
 * AuthCallback handles the Google OAuth redirect.
 * After Google authenticates, Supabase redirects here.
 * 
 * Logic:
 * - If the Google email already exists in the profiles table → go to dashboard
 * - If it does NOT exist → redirect to signup form with Google email/id in state
 * - If navigated here with ?flow=signup, always redirect to signup form
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const location = useLocation();
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

      // Check if this is a signup flow (user came from signup page)
      const params = new URLSearchParams(location.search);
      const flow = params.get('flow');

      if (flow === 'signup') {
        // Always go to signup form for signup flow
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
        return;
      }

      // Login flow: check if user has a profile (completed registration)
      setStatus('Checking your account...');
      
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('id', googleUserId)
        .single();

      if (profileError || !profile) {
        // No profile exists → user hasn't completed registration
        // Redirect to signup form with Google data
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
        return;
      }

      // Profile exists → user is registered, go to dashboard
      setStatus('Welcome back! Redirecting...');
      navigate('/my-cases', { replace: true });
    };

    handleCallback();
  }, [navigate, location.search]);

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
