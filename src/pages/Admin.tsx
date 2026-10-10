import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { hasPermission, ROLE_LABELS, type Permission } from '../config/site'
import { Skeleton } from '../components/ui'
import {
  IconAlert,
  IconBank,
  IconChart,
  IconClipboard,
  IconClose,
  IconCog,
  IconHome,
  IconMegaphone,
  IconMenu,
  IconShield,
  IconUsers,
  IconWallet,
  IconChevron,
} from '../components/icons'

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

const Loading = () => (
  <div className="space-y-3 py-6">
    <Skeleton className="h-10 w-48" />
    <Skeleton className="h-32" />
    <Skeleton className="h-32" />
  </div>
)

type Item = {
  label: string
  permission: Permission
  path: string
  icon: ComponentType<{ className?: string }>
  group: 'Overview' | 'Lending' | 'Finance' | 'Operations'
}

/**
 * Mirrors the permission matrix. Database policies and RPC guards enforce the same access.
 */
const NAV: Item[] = [
  {
    label: 'Dashboard',
    path: '/admin',
    icon: IconHome,
    group: 'Overview',
    permission: 'dashboard.view',
  },
  { label: 'Students', path: '/admin/students', icon: IconUsers, group: 'Lending', permission: 'customers.view' },
  {
    label: 'Applications',
    path: '/admin/applications',
    icon: IconClipboard,
    group: 'Lending',
    permission: 'applications.view',
  },
  {
    label: 'Loans',
    path: '/admin/loans',
    icon: IconBank,
    group: 'Lending',
    permission: 'loans.view',
  },
  {
    label: 'Repayments',
    path: '/admin/repayments',
    icon: IconWallet,
    group: 'Finance',
    permission: 'repayments.view',
  },
  {
    label: 'Collections',
    path: '/admin/collections',
    icon: IconAlert,
    group: 'Finance',
    permission: 'collections.view',
  },
  {
    label: 'Reports',
    path: '/admin/reports',
    icon: IconChart,
    group: 'Finance',
    permission: 'reports.view',
  },
  {
    label: 'Marketing',
    path: '/admin/marketing',
    icon: IconMegaphone,
    group: 'Operations',
    permission: 'marketing.view',
  },
  { label: 'Audit Log', path: '/admin/audit-log', icon: IconShield, group: 'Operations', permission: 'audit_logs.view' },
  { label: 'Settings', path: '/admin/settings', icon: IconCog, group: 'Operations', permission: 'settings.view' },
]

const GROUPS: Item['group'][] = ['Overview', 'Lending', 'Finance', 'Operations']
const SIDEBAR_KEY = 'ogeseous:sidebar-collapsed'

export default function AdminShell() {
  const { role, signOut } = useAuth()
  const nav = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1')
  }, [])

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      return next
    })
  }

  const items = NAV.filter((item) => hasPermission(role, item.permission))
  const allowed = (permission: Permission) => hasPermission(role, permission)
  const out = () => nav('/')

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-4" aria-label="Admin">
      {GROUPS.map((group) => {
        const groupItems = items.filter((i) => i.group === group)
        if (!groupItems.length) return null
        return (
          <div key={group}>
            {!collapsed && (
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-200/70">
                {group}
              </p>
            )}
            <div className="flex flex-col gap-1">
              {groupItems.map((i) => {
                const Icon = i.icon
                return (
                  <NavLink
                    key={i.label}
                    to={i.path}
                    end={i.path === '/admin'}
                    title={collapsed ? i.label : undefined}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                        isActive ? 'bg-white/15 font-semibold text-white' : 'text-slate-200 hover:bg-white/10'
                      } ${collapsed ? 'justify-center' : ''}`
                    }
                  >
                    <Icon />
                    {!collapsed && (
                      <span>{role === 'ACCOUNTANT' && i.label === 'Loans' ? 'Disbursements' : i.label}</span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )

  return (
    <div className="flex min-h-[calc(100vh-64px)] bg-mist">
      <aside
        className={`relative hidden shrink-0 flex-col bg-navy p-3 text-slate-200 motion-safe:transition-[width] motion-safe:duration-300 md:flex ${
          collapsed ? 'w-[4.5rem]' : 'w-60'
        }`}
      >
        <button
          type="button"
          className="mb-4 grid h-10 w-10 place-items-center self-end rounded-lg text-white hover:bg-white/10"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
        >
          <span className={collapsed ? 'rotate-180' : ''}>
            <IconChevron />
          </span>
        </button>
        <NavList />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b bg-white/90 px-4 py-3 text-sm backdrop-blur">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 md:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <IconMenu />
            </button>
            <span>
              Signed in as <b>{role ? ROLE_LABELS[role] : '—'}</b>
            </span>
          </div>
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

        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-navy/40"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="relative z-10 flex h-full w-72 flex-col bg-navy p-4 text-slate-200 motion-safe:animate-slide-in-left">
              <div className="mb-4 flex items-center justify-between">
                <p className="font-semibold text-white">Menu</p>
                <button type="button" className="p-2 text-white" aria-label="Close menu" onClick={() => setMobileOpen(false)}>
                  <IconClose />
                </button>
              </div>
              <NavList onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        <div className="p-4 md:p-8">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<AdminDashboard />} />
              <Route path="dashboard" element={<AdminDashboard />} />
              <Route path="students" element={allowed('customers.view') ? <AdminStudents /> : <AccessDenied />} />
              <Route
                path="applications"
                element={allowed('applications.view') ? <AdminLoanApplications /> : <AccessDenied />}
              />
              <Route
                path="applications/:id"
                element={
                  allowed('applications.view') || allowed('applications.disbursement_view')
                    ? <AdminApplicationDetail />
                    : <AccessDenied />
                }
              />
              <Route path="loan-applications" element={<Navigate to="/admin/applications" replace />} />
              <Route path="loans" element={allowed('loans.view') ? <AdminLoans /> : <AccessDenied />} />
              <Route
                path="repayments"
                element={allowed('repayments.view') ? <AdminRepayments /> : <AccessDenied />}
              />
              <Route
                path="collections"
                element={allowed('collections.view') ? <AdminCollections /> : <AccessDenied />}
              />
              <Route path="marketing" element={allowed('marketing.view') ? <AdminMarketing /> : <AccessDenied />} />
              <Route path="reports" element={allowed('reports.view') ? <AdminReports /> : <AccessDenied />} />
              <Route path="audit-log" element={allowed('audit_logs.view') ? <AdminAuditLog /> : <AccessDenied />} />
              <Route path="settings" element={allowed('settings.view') ? <AdminSettings /> : <AccessDenied />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  )
}

function AccessDenied() {
  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-red-200 bg-white p-8 text-center">
      <p className="text-sm font-bold uppercase tracking-wider text-red-700">403 · Unauthorized</p>
      <h1 className="mt-2 text-2xl font-bold text-navy">Access denied</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your staff role does not have permission to view this page.
      </p>
      <NavLink className="btn-blue mt-5 inline-flex" to="/admin">
        Back to dashboard
      </NavLink>
    </div>
  )
}
