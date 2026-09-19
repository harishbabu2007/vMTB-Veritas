import { useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { CheckCircle } from 'lucide-react';

interface LocationState {
  email?: string;
  type?: 'password-reset' | 'verification';
}

export function CheckYourEmail() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;

  useEffect(() => {
    // Redirect if no email state provided
    if (!state?.email) {
      navigate('/login');
    }
  }, [state, navigate]);

  const email = state?.email || '';
  const isPasswordReset = state?.type === 'password-reset';

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          {/* Header */}
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          {/* Content */}
          <div className="text-center">
            {/* Icon */}
            <div className="inline-flex items-center justify-center bg-green-100 rounded-full mb-6 w-16 h-16">
              <CheckCircle className="text-green-600 w-8 h-8" strokeWidth={1.5} />
            </div>

            {/* Title */}
            <h2 className="text-2xl font-semibold text-text mb-3">
              Check Your Email
            </h2>

            {/* Message */}
            <div className="mb-8">
              <p className="text-text-muted mb-2">
                {isPasswordReset
                  ? "We've sent a password reset link to:"
                  : "We've sent a verification link to:"}
              </p>
              <p className="text-lg font-semibold text-text break-all">
                {email}
              </p>
            </div>

            {/* Additional Info */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-8">
              <p className="text-sm text-blue-900">
                {isPasswordReset
                  ? 'Click the link in the email to reset your password. The link will expire in 1 hour.'
                  : 'Click the link in the email to verify your account. The link will expire in 24 hours.'}
              </p>
            </div>

            {/* Checks */}
            <div className="space-y-2 mb-8 text-left">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
                  <svg className="w-3 h-3 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <p className="text-sm text-text">Check your email inbox</p>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
                  <svg className="w-3 h-3 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <p className="text-sm text-text">Check your spam or junk folder if needed</p>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
                  <svg className="w-3 h-3 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <p className="text-sm text-text">Click the link to continue</p>
              </div>
            </div>

            {/* Didn't receive email? */}
            <div className="pt-6 border-t border-border">
              <p className="text-sm mb-4 text-text-muted">
                Didn't receive the email?
              </p>
              <button
                onClick={() => window.location.href = '/'}
                className="text-sm font-medium transition mb-4 text-primary"
              >
                Try again with a different email
              </button>
            </div>
          </div>

          {/* Back to Login */}
          <div className="mt-8 text-center">
            <Link
              to="/login"
              className="text-sm font-medium transition text-text-muted"
            >
              ← Back to login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
