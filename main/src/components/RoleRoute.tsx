import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, UserRole } from '../context/AuthContext';

// Where each role lands at its own "home" -- used by RoleRoute when a role
// hits a route it isn't allowed on, and by AuthRedirect at the root `/`.
export function roleHomePath(role: UserRole | null): string {
  switch (role) {
    case 'site_data_coordinator':
      return '/sdc/my-cases';
    case 'mtb_expert':
      return '/mtb-exp/mtbs';
    default:
      return '/my-cases';
  }
}

// A clinician sees the bare paths, an SDC sees `/sdc/*`, an MTB Expert sees
// `/mtb-exp/*`. Every page component shared across all three prefixes
// (Layout's nav links, MTBs/MTBDetail/ViewCase's internal navigate calls)
// must prepend this to any same-app path it builds.
export function useRolePrefix(): '' | '/sdc' | '/mtb-exp' {
  const { role } = useAuth();
  if (role === 'site_data_coordinator') return '/sdc';
  if (role === 'mtb_expert') return '/mtb-exp';
  return '';
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-text-muted font-medium animate-pulse">Loading...</div>
    </div>
  );
}

// Supersedes ProtectedRoute: performs the same auth/registration checks,
// then additionally requires the signed-in account's role to be one of
// `allowedRoles` -- redirecting to that role's own home otherwise, so a
// clinician can never be served an /sdc or /mtb-exp page (or vice versa)
// by typed URL, bookmark, or back button.
export function RoleRoute({ allowedRoles, children }: { allowedRoles: UserRole[]; children: ReactNode }) {
  const { isAuthenticated, loading, registrationComplete, role } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingScreen />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (registrationComplete === null) return <LoadingScreen />;

  if (registrationComplete === false) {
    return <Navigate to="/signup" replace />;
  }

  // role === null: registration is complete but the profile row's role
  // hasn't resolved yet -- same "still checking" treatment as
  // registrationComplete === null above, not "no role."
  if (role === null) return <LoadingScreen />;

  if (!allowedRoles.includes(role)) {
    return <Navigate to={roleHomePath(role)} replace />;
  }

  return <>{children}</>;
}
