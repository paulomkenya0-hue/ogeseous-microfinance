import { Navigate, Outlet, Link } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { canAccessAdminArea } from '../config/site'

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

  // A signed-in user in the wrong area receives an explicit authorization response rather than
  // being redirected to a different page and left to infer that access was denied.
  const allowed = area === 'student' ? role === 'STUDENT' : canAccessAdminArea(role)
  if (!allowed) {
    return (
      <Centred>
        <div>
          <p className="text-sm font-bold uppercase tracking-wider text-red-700">403 · Unauthorized</p>
          <h1 className="mt-2 text-xl font-bold text-navy">Access denied</h1>
          <p className="mt-2 text-sm text-slate-600">
            Your account does not have permission to access this area.
          </p>
        </div>
      </Centred>
    )
  }

  return <Outlet />
}

const Centred = ({ children }: { children: React.ReactNode }) => (
  <div className="grid min-h-[60vh] place-items-center p-10 text-center">{children}</div>
)
