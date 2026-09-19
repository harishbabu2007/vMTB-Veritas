import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Layout } from '../components/Layout';
import { useAuth } from '../context/AuthContext';

// Catch-all for unknown routes. Signed-in users keep the app header so they
// can navigate away; signed-out visitors get a standalone page pointing to login.
export function NotFound() {
  const { isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  const homePath = isAuthenticated ? '/my-cases' : '/login';
  const homeLabel = isAuthenticated ? 'Go to My Cases' : 'Go to login';

  const content = (
    <div className="flex flex-col items-center text-center py-16 px-4">
      <p className="text-6xl font-bold tracking-tight text-primary">404</p>
      <h1 className="mt-4 text-2xl font-semibold text-text">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-text-muted">
        There's nothing at <span className="font-mono text-text break-all">{location.pathname}</span>. Check the address, or head back to somewhere you know.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {window.history.length > 1 && (
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-border rounded-lg text-text bg-surface hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Go back</span>
          </button>
        )}
        <button
          onClick={() => navigate(homePath, { replace: true })}
          className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors"
        >
          {homeLabel}
        </button>
      </div>
    </div>
  );

  if (isAuthenticated) {
    return <Layout>{content}</Layout>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      {content}
    </div>
  );
}
