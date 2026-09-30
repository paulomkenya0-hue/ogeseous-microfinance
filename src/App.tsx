import { Routes, Route, Link } from 'react-router-dom'
import Layout from './components/Layout'; import ProtectedRoute from './auth/ProtectedRoute'
import { Home, About, HowItWorks, Contact, Legal } from './pages/Public'
import { Login, Register } from './pages/Auth'; import StudentDashboard from './pages/Student'; import Verify from './pages/Verify'; import LoanApply from './pages/LoanApply'
import ApplicationView from './pages/ApplicationView'; import StudentLoan from './pages/StudentLoan'; import VerifyPublic from './pages/VerifyPublic'; import AdminShell from './pages/Admin'
export default function App() {
  return <Routes><Route element={<Layout />}>
    <Route path="/" element={<Home />} /><Route path="/about" element={<About />} /><Route path="/how-it-works" element={<HowItWorks />} />
    <Route path="/contact" element={<Contact />} /><Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} />
    <Route path="/privacy" element={<Legal title="Privacy Policy" />} /><Route path="/terms" element={<Legal title="Terms & Conditions" />} /><Route path="/verify" element={<VerifyPublic />} />
    <Route element={<ProtectedRoute area="student" />}><Route path="/student/dashboard" element={<StudentDashboard />} /><Route path="/student/verify" element={<Verify />} /><Route path="/student/apply" element={<LoanApply />} /><Route path="/student/application" element={<ApplicationView />} /><Route path="/student/loan" element={<StudentLoan />} /></Route>
    <Route element={<ProtectedRoute area="admin" />}><Route path="/admin/*" element={<AdminShell />} /></Route>
    <Route path="*" element={<div className="p-16 text-center"><h1 className="text-2xl font-bold">Page not found</h1><Link className="text-brand underline" to="/">Go home</Link></div>} />
  </Route></Routes>
}
