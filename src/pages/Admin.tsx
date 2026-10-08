import { lazy, Suspense } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ROLE_LABELS, type Role } from '../config/site'

/**
 * Every admin page is its own chunk. None of this is needed by a student, and none of it is
 * needed by an admin who only ever opens one tab.
 */
const AdminDashboard = lazy(() => import('./AdminDashboard'))
const AdminStudents = lazy(() => import('./AdminStudents'))
const AdminMarketing = lazy(() => import('./AdminMarketing'))
const AdminLoanApplications = lazy(() => import('./AdminLoanApplications'))
const AdminApplicationDetail = lazy(() => import('./AdminApplicationDetail'))
const AdminLoans = lazy(() => import('./AdminLoans'))
const AdminRepayments = lazy(() => import('./AdminRepayments'))
const AdminCollections = lazy(() => import('./AdminCollections'))
const AdminReports = lazy(() => import('./AdminReports'))
const AdminSettings = lazy(() => import('./AdminSettings'))
const AdminAuditLog = lazy(() => import('./AdminAuditLog'))

const Loading = () => <p className="py-10 text-center text-slate-500">Loading…</p>

type Item = { label: string; roles: Role[] }

/**
 * Mirrors the Row Level Security policies in migrations 001-008, which are the real control.
 * The old navigation showed all nine links to every role, so an accountant's "Loan
 * Applications" page silently rendered an empty table — `staff read applications` covers
 * LOAN_OFFICER, MANAGER and SUPER_ADMIN only, and no accountant row can be read.
 * Hiding the link turns a silent wrong answer into an obvious absence.
 */
const NAV: Item[] = [
  { label: 'Dashboard', roles: ['LOAN_OFFICER', 'ACCOUNTANT', 'COLLECTION_OFFICER', 'MARKETING_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  // verification_requests and rcu_students are readable by is_admin() = MANAGER / SUPER_ADMIN.
  { label: 'Students', roles: ['MANAGER', 'SUPER_ADMIN'] },
  { label: 'Applications', roles: ['LOAN_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  { label: 'Loans', roles: ['LOAN_OFFICER', 'ACCOUNTANT', 'COLLECTION_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  { label: 'Repayments', roles: ['ACCOUNTANT', 'COLLECTION_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  { label: 'Collections', roles: ['ACCOUNTANT', 'COLLECTION_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  { label: 'Marketing', roles: ['MARKETING_OFFICER', 'MANAGER', 'SUPER_ADMIN'] },
  // get_dashboard_stats() is ACCOUNTANT / MANAGER / SUPER_ADMIN.
  { label: 'Reports', roles: ['ACCOUNTANT', 'MANAGER', 'SUPER_ADMIN'] },
  // audit_logs is readable by is_admin(); setting changes are MANAGER and up; role assignment
  // is SUPER_ADMIN only, and AdminSettings hides that panel for anyone else.
  { label: 'Audit Log', roles: ['MANAGER', 'SUPER_ADMIN'] },
  { label: 'Settings', roles: ['MANAGER', 'SUPER_ADMIN'] },
]

const slug = (s: string) => s.toLowerCase().replace(/ /g, '-')

export default function AdminShell() {
  const { role, signOut } = useAuth()
  const nav = useNavigate()

  const items = role === 'SUPER_ADMIN' ? NAV : NAV.filter((i) => role && i.roles.includes(role))
  const allowed = (label: string) => role === 'SUPER_ADMIN' || items.some((i) => i.label === label)
  const out = () => nav('/')

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col md:flex-row">
      <aside className="bg-navy p-3 text-sm text-slate-200 md:w-56">
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Admin">
          {items.map((i) => (
            <NavLink
              key={i.label}
              to={`/admin/${slug(i.label)}`}
              end={i.label === 'Dashboard'}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 ${
                  isActive ? 'bg-white/15 font-semibold text-white' : 'hover:bg-white/10'
                }`
              }
            >
              {i.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1">
        <div className="flex items-center justify-between border-b bg-white px-4 py-3 text-sm">
          <span>
            Signed in as <b>{role ? ROLE_LABELS[role] : '—'}</b>
          </span>
          <button
            className="btn-outline"
            onClick={async () => {
              await signOut()
              out()
            }}
          >
            Sign out
          </button>
        </div>

        <div className="p-4 md:p-8">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<AdminDashboard />} />
              <Route path="students" element={allowed('Students') ? <AdminStudents /> : <Navigate to="/admin" replace />} />
              <Route path="applications" element={allowed('Applications') ? <AdminLoanApplications /> : <Navigate to="/admin" replace />} />
              {/* One application, in full, with its documents and its history. Same role gate as the
                  list: reviewing applications is LOAN_OFFICER and up, and the detail page reads
                  loan_documents and the documents in storage, both of which carry that same gate. */}
              <Route path="applications/:id" element={allowed('Applications') ? <AdminApplicationDetail /> : <Navigate to="/admin" replace />} />
              <Route path="loan-applications" element={<Navigate to="/admin/applications" replace />} />
              <Route path="loans" element={allowed('Loans') ? <AdminLoans /> : <Navigate to="/admin" replace />} />
              <Route path="repayments" element={allowed('Repayments') ? <AdminRepayments /> : <Navigate to="/admin" replace />} />
              <Route path="collections" element={allowed('Collections') ? <AdminCollections /> : <Navigate to="/admin" replace />} />
              <Route path="marketing" element={allowed('Marketing') ? <AdminMarketing /> : <Navigate to="/admin" replace />} />
              <Route path="reports" element={allowed('Reports') ? <AdminReports /> : <Navigate to="/admin" replace />} />
              <Route path="audit-log" element={allowed('Audit Log') ? <AdminAuditLog /> : <Navigate to="/admin" replace />} />
              <Route path="settings" element={allowed('Settings') ? <AdminSettings /> : <Navigate to="/admin" replace />} />
              {/* An old bookmarked URL, or a marketing officer landing on /admin/dashboard. */}
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  )
}