import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
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
import { MeetingDetail } from './pages/MeetingDetail';
import { ViewCase } from './pages/ViewCase';

function AuthRedirect() {
  const { isAuthenticated, loading, isInPasswordRecovery } = useAuth();
  const location = useLocation();
  
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-600 font-medium animate-pulse">Loading...</div>
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
        <CasesProvider>
          <CaseCreationProvider>
            <Toaster
              position="bottom-right"
              toastOptions={{
                className: 'toast-slide-up',
              }}
            />
            <AuthRecoveryHandler />
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
            <Route
              path="/mtb/:mtbId/meeting/:meetingId"
              element={
                <ProtectedRoute>
                  <MeetingDetail />
                </ProtectedRoute>
              }
            />

            <Route path="/" element={<AuthRedirect />} />
          </Routes>
        </CaseCreationProvider>
      </CasesProvider>
    </AuthProvider>
  </BrowserRouter>
  );
}

export default App;
