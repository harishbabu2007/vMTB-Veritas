import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import toast, { Toaster, ToastBar } from 'react-hot-toast';
import { DismissButton } from './components/DismissButton';
import { TourOverlay } from './components/onboarding/TourOverlay';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { OnboardingProvider } from './context/OnboardingContext';
import { CasesProvider } from './context/CasesContext';
import { CaseCreationProvider } from './context/CaseCreationContext';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { AuthCallback } from './pages/AuthCallback';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { MyCases } from './pages/MyCases';
import NewCaseStep1 from './pages/NewCaseStep1';
import NewCaseStep2 from './pages/NewCaseStep2';
import ReviewCase from './pages/ReviewCase';
import { MTBs } from './pages/MTBs';
import { MTBDetail } from './pages/MTBDetail';
import { ViewCase } from './pages/ViewCase';
import { NotFound } from './pages/NotFound';
import { SampleCase } from './pages/SampleCase';
import { SampleBoard } from './pages/SampleBoard';

function AuthRedirect() {
  const { isAuthenticated, loading, isInPasswordRecovery } = useAuth();
  const location = useLocation();
  
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }
  
  // Allow user to stay on /reset-password during password recovery
  if (isInPasswordRecovery && location.pathname === '/reset-password') {
    return null;
  }
  
  // Also check for recovery hash in URL - prevents redirect before PASSWORD_RECOVERY event fires
  if (location.pathname === '/reset-password' && location.hash.includes('access_token')) {
    return null;
  }
  
  return <Navigate to={isAuthenticated ? "/my-cases" : "/login"} />;
}

function AuthRecoveryHandler() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    // Handle recovery links from Supabase
    // Supabase sends recovery data in URL hash (#access_token=...&type=recovery)
    // The redirect_to parameter sends user to /reset-password
    // Just let the hash pass through - don't redirect
    
    // Only intervene if for some reason recovery params are in search params
    const params = new URLSearchParams(location.search);
    const type = params.get('type');

    if (type === 'recovery' && location.pathname !== '/reset-password') {
      // Preserve hash to ensure recovery token is not lost
      navigate(`/reset-password${location.search}${location.hash}`, { replace: true });
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-text-muted font-medium animate-pulse">Loading...</div>
      </div>
    );
  }
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  
  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
        <OnboardingProvider>
        <CasesProvider>
          <CaseCreationProvider>
            {/* Above every full-screen overlay (Modal 99999-100000, document
                workspace 110000) — at react-hot-toast's default 9999, a
                success or error message raised while one was open rendered
                underneath it and was never seen. */}
            <Toaster
              position="bottom-right"
              containerStyle={{ zIndex: 130000 }}
              toastOptions={{
                className: 'toast-slide-up',
              }}
            >
              {(t) => (
                <ToastBar toast={t}>
                  {({ icon, message }) => (
                    <>
                      {icon}
                      {message}
                      {t.type !== 'loading' && (
                        <DismissButton onClick={() => toast.dismiss(t.id)} label="Dismiss notification" />
                      )}
                    </>
                  )}
                </ToastBar>
              )}
            </Toaster>
            <AuthRecoveryHandler />
            <TourOverlay />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

            <Route
              path="/my-cases"
              element={
                <ProtectedRoute>
                  <MyCases />
                </ProtectedRoute>
              }
            />
            <Route
              path="/cases/new/step-1"
              element={
                <ProtectedRoute>
                  <NewCaseStep1 />
                </ProtectedRoute>
              }
            />
            <Route
              path="/cases/new/step-2"
              element={
                <ProtectedRoute>
                  <NewCaseStep2 />
                </ProtectedRoute>
              }
            />
            <Route
              path="/cases/review"
              element={
                <ProtectedRoute>
                  <ReviewCase />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sample-case"
              element={
                <ProtectedRoute>
                  <SampleCase />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sample-board"
              element={
                <ProtectedRoute>
                  <SampleBoard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/mtbs"
              element={
                <ProtectedRoute>
                  <MTBs />
                </ProtectedRoute>
              }
            />
            <Route
              path="/mtb/:id"
              element={
                <ProtectedRoute>
                  <MTBDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/case/:id"
              element={
                <ProtectedRoute>
                  <ViewCase />
                </ProtectedRoute>
              }
            />
            <Route
              path="/mtb/:mtbId/case/:id"
              element={
                <ProtectedRoute>
                  <ViewCase />
                </ProtectedRoute>
              }
            />

            <Route path="/" element={<AuthRedirect />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </CaseCreationProvider>
      </CasesProvider>
      </OnboardingProvider>
      </ThemeProvider>
    </AuthProvider>
  </BrowserRouter>
  );
}

export default App;
