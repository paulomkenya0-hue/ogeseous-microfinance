import { Suspense, lazy } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import ProtectedRoute from './auth/ProtectedRoute'
import { Login, Register } from './pages/Auth'

/**
 * The public pages are one small module with five exports. Splitting them would achieve nothing:
 * as long as Home is needed for the landing page, the whole module is fetched anyway, so
 * `lazy()` around its siblings only added Suspense wrappers and a build warning.
 */
import { Home, About, HowItWorks, Contact, Legal } from './pages/Public'

/**
 * Everything else is its own chunk.
 *
 * The single bundle was 861KB (264KB gzipped) because jsPDF — and with it html2canvas and
 * DOMPurify, together around 350KB — was pulled in for students who never open the application
 * PDF, because ApplicationView.tsx imported it at module scope. Splitting the routes and importing
 * jsPDF only inside the download handler keeps it out of every other page's cost.
 */
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const VerifyPublic = lazy(() => import('./pages/VerifyPublic'))
const StudentDashboard = lazy(() => import('./pages/Student'))
const Verify = lazy(() => import('./pages/Verify'))
const LoanApply = lazy(() => import('./pages/LoanApply'))
const ApplicationView = lazy(() => import('./pages/ApplicationView'))
const StudentLoan = lazy(() => import('./pages/StudentLoan'))
const AdminShell = lazy(() => import('./pages/Admin'))

const Loading = () => <p className="p-10 text-center text-slate-500">Loading…</p>

const NotFound = () => (
  <div className="p-16 text-center">
    <h1 className="text-2xl font-bold">Page not found</h1>
    <Link className="text-brand underline" to="/">
      Go home
    </Link>
  </div>
)

export default function App() {
  return (
    <ErrorBoundary>
      {/* One boundary for the whole route tree. Wrapping each lazy route individually produced the
          same fallback eleven times and made every route three lines longer than it needed to be. */}
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            {/* Reached from the password reset email. Public because the recovery session, not the
                route, is what authorises it — ProtectedRoute would redirect it straight back. */}
            <Route path="/reset-password" element={<ResetPassword />} />

            <Route path="/privacy" element={<Legal title="Privacy Policy" />} />
            <Route path="/terms" element={<Legal title="Terms & Conditions" />} />
            <Route path="/verify" element={<VerifyPublic />} />

            <Route element={<ProtectedRoute area="student" />}>
              <Route path="/student/dashboard" element={<StudentDashboard />} />
              <Route path="/student/verify" element={<Verify />} />
              <Route path="/student/apply" element={<LoanApply />} />
              <Route path="/student/application" element={<ApplicationView />} />
              <Route path="/student/loan" element={<StudentLoan />} />
            </Route>

            <Route element={<ProtectedRoute area="admin" />}>
              <Route path="/admin/*" element={<AdminShell />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}