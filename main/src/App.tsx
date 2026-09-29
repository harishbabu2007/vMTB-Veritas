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
import { MTBs } from './pages/MTBs';
import { MTBDetail } from './pages/MTBDetail';
import { MeetingDetail } from './pages/MeetingDetail';
import { ViewCase } from './pages/ViewCase';
import { NotFound } from './pages/NotFound';
import { SampleCase } from './pages/SampleCase';
import { SampleBoard } from './pages/SampleBoard';
import { RoleRoute, roleHomePath } from './components/RoleRoute';

function AuthRedirect() {
  const { isAuthenticated, loading, isInPasswordRecovery, registrationComplete, role } = useAuth();
  const location = useLocation();

  // registrationComplete === null means "still checking" for a signed-in
  // user, same as `loading` -- an abandoned Google signup (a real session,
  // no finished profile) must not flash through to /my-cases while that
  // check is still in flight. Once registration is complete, `role` gets
  // the same "still checking" treatment before it's used to pick a home.
  if (loading || (isAuthenticated && (registrationComplete === null || (registrationComplete && role === null)))) {
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

  // Signed in but never finished registration (e.g. Google auth completed,
  // then the tab closed before the WhatsApp OTP step) -- send them back to
  // pick up signup where they left off, not into the app.
  if (isAuthenticated && registrationComplete === false) {
    return <Navigate to="/signup" replace />;
  }

  return <Navigate to={isAuthenticated ? roleHomePath(role) : "/login"} />;
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
                // Themed defaults for every toast, including direct toast() calls.
                style: {
                  background: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                },
                success: { iconTheme: { primary: 'var(--color-success)', secondary: 'var(--color-surface)' } },
                error: { iconTheme: { primary: 'var(--color-danger)', secondary: 'var(--color-surface)' } },
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

            {/* Clinician (bare paths) */}
            <Route path="/my-cases" element={<RoleRoute allowedRoles={['clinician']}><MyCases /></RoleRoute>} />
            <Route path="/cases/new/step-1" element={<RoleRoute allowedRoles={['clinician']}><NewCaseStep1 /></RoleRoute>} />
            <Route path="/cases/new/step-2" element={<RoleRoute allowedRoles={['clinician']}><NewCaseStep2 /></RoleRoute>} />
            <Route path="/sample-case" element={<RoleRoute allowedRoles={['clinician']}><SampleCase /></RoleRoute>} />
            <Route path="/sample-board" element={<RoleRoute allowedRoles={['clinician']}><SampleBoard /></RoleRoute>} />
            <Route path="/mtbs" element={<RoleRoute allowedRoles={['clinician']}><MTBs /></RoleRoute>} />
            <Route path="/mtb/:id" element={<RoleRoute allowedRoles={['clinician']}><MTBDetail /></RoleRoute>} />
            <Route path="/case/:id" element={<RoleRoute allowedRoles={['clinician']}><ViewCase /></RoleRoute>} />
            <Route path="/mtb/:mtbId/case/:id" element={<RoleRoute allowedRoles={['clinician']}><ViewCase /></RoleRoute>} />
            <Route path="/mtb/:mtbId/meeting/:meetingId" element={<RoleRoute allowedRoles={['clinician']}><MeetingDetail /></RoleRoute>} />

            {/* Site Data Coordinator -- full parity with clinician except
                Opinions and meetings (gated inside the shared components
                themselves), so it reuses the same page components under
                /sdc/*. No meeting route: SDC has no meeting access at all. */}
            <Route path="/sdc/my-cases" element={<RoleRoute allowedRoles={['site_data_coordinator']}><MyCases /></RoleRoute>} />
            <Route path="/sdc/cases/new/step-1" element={<RoleRoute allowedRoles={['site_data_coordinator']}><NewCaseStep1 /></RoleRoute>} />
            <Route path="/sdc/cases/new/step-2" element={<RoleRoute allowedRoles={['site_data_coordinator']}><NewCaseStep2 /></RoleRoute>} />
            <Route path="/sdc/sample-case" element={<RoleRoute allowedRoles={['site_data_coordinator']}><SampleCase /></RoleRoute>} />
            <Route path="/sdc/sample-board" element={<RoleRoute allowedRoles={['site_data_coordinator']}><SampleBoard /></RoleRoute>} />
            <Route path="/sdc/mtbs" element={<RoleRoute allowedRoles={['site_data_coordinator']}><MTBs /></RoleRoute>} />
            <Route path="/sdc/mtb/:id" element={<RoleRoute allowedRoles={['site_data_coordinator']}><MTBDetail /></RoleRoute>} />
            <Route path="/sdc/case/:id" element={<RoleRoute allowedRoles={['site_data_coordinator']}><ViewCase /></RoleRoute>} />
            <Route path="/sdc/mtb/:mtbId/case/:id" element={<RoleRoute allowedRoles={['site_data_coordinator']}><ViewCase /></RoleRoute>} />

            {/* MTB Expert -- no case-creation, no My Cases, no meeting-start
                route (meeting is only ever reached from an MTB board it
                belongs to, so /mtb-exp/mtb/:mtbId/meeting/:meetingId is the
                only meeting route this role needs). */}
            <Route path="/mtb-exp/mtbs" element={<RoleRoute allowedRoles={['mtb_expert']}><MTBs /></RoleRoute>} />
            <Route path="/mtb-exp/mtb/:id" element={<RoleRoute allowedRoles={['mtb_expert']}><MTBDetail /></RoleRoute>} />
            <Route path="/mtb-exp/case/:id" element={<RoleRoute allowedRoles={['mtb_expert']}><ViewCase /></RoleRoute>} />
            <Route path="/mtb-exp/mtb/:mtbId/case/:id" element={<RoleRoute allowedRoles={['mtb_expert']}><ViewCase /></RoleRoute>} />
            <Route path="/mtb-exp/mtb/:mtbId/meeting/:meetingId" element={<RoleRoute allowedRoles={['mtb_expert']}><MeetingDetail /></RoleRoute>} />

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
