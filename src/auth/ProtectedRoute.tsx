import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { STAFF_ROLES } from '../config/site'
// UX guard only. Real enforcement is Row Level Security in the database.
export default function ProtectedRoute({ area }: { area: 'student' | 'admin' }) {
  const { session, role, loading } = useAuth()
  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
  const ok = area === 'student' ? role === 'STUDENT' : role !== null && (STAFF_ROLES as readonly string[]).includes(role)
  if (!ok) return <Navigate to={role === 'STUDENT' ? '/student/dashboard' : role ? '/admin' : '/login'} replace />
  return <Outlet />
}
