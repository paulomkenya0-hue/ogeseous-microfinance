import { Navigate, Outlet, Link } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { STAFF_ROLES } from '../config/site'
import SuperAdminMfaGate from './SuperAdminMfaGate'

/**
 * A UX guard only — the comment in 001_foundation.sql is right about that. Row Level Security and
 * the SECURITY DEFINER functions are the enforcement, and they do not care what this component
 * decides. What this must get right is not *whether* to allow access but *what to say*: telling a
 * signed-in user to log in because one query failed is how people end up locked out.
 */
export default function ProtectedRoute({ area }: { area: 'student' | 'admin' }) {
  const { session, role, loading, error, refresh } = useAuth()

  if (!session && !loading) return <Navigate to="/login" replace />
  if (loading) return <Centred>Loading…</Centred>

  // Signed in, but we could not determine the role. Retry rather than redirect.
  if (role === undefined) {
    return (
      <Centred>
        <p className="text-sm text-slate-600">{error || 'We could not confirm your access level.'}</p>
        <button className="btn-blue mt-4" onClick={() => void refresh()}>
          Try again
        </button>
      </Centred>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  // Settled, and there is no usable role: suspended, unknown, or simply not this person.
  if (role === null) {
    return (
      <Centred>
        <h1 className="text-xl font-bold text-navy">Account unavailable</h1>
        <p className="mt-2 max-w-sm text-sm text-slate-600">
          This account is not active. If you think that is wrong, contact OGESEOUS Microfinance.
        </p>
        <Link className="btn-blue mt-4" to="/">
          Go home
        </Link>
      </Centred>
    )
  }

  // Each area sends you to the other one rather than to a dead end. A staff member who followed a
  // student link lands on the admin console instead of being told to log in again, and vice versa.
  const allowed = area === 'student' ? role === 'STUDENT' : (STAFF_ROLES as readonly string[]).includes(role)
  if (!allowed) return <Navigate to={role === 'STUDENT' ? '/dashboard' : '/admin'} replace />

  if (area === 'admin' && role === 'SUPER_ADMIN') {
    return (
      <SuperAdminMfaGate>
        <Outlet />
      </SuperAdminMfaGate>
    )
  }

  return <Outlet />
}

const Centred = ({ children }: { children: React.ReactNode }) => (
  <div className="grid min-h-[60vh] place-items-center p-10 text-center">{children}</div>
)
