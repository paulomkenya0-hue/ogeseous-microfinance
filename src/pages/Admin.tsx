import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'; import { useAuth } from '../auth/AuthContext'
import AdminStudents from './AdminStudents'; import AdminMarketing from './AdminMarketing'
import AdminLoanApplications from './AdminLoanApplications'; import AdminLoans from './AdminLoans'
import AdminRepayments from './AdminRepayments'; import AdminCollections from './AdminCollections'; import AdminReports from './AdminReports'

const allItems = ['Dashboard', 'Students', 'Loan Applications', 'Loans', 'Repayments', 'Collections', 'Marketing', 'Reports', 'Settings']
const officerItems = ['Dashboard', 'Marketing'] // marketing officers only see their own dashboard + referral performance
const slug = (s: string) => s === 'Dashboard' ? '' : s.toLowerCase().replace(/ /g, '-')
const Empty = ({ t }: { t: string }) => <div><h1 className="mb-4 text-2xl font-bold text-navy">{t}</h1><div className="card text-slate-600">Coming in next development phase.</div></div>
const Wrap = ({ t, children }: { t: string; children: React.ReactNode }) => <div><h1 className="mb-4 text-2xl font-bold text-navy">{t}</h1>{children}</div>

export default function AdminShell() {
  const { role, signOut } = useAuth(); const nav = useNavigate()
  const items = role === 'MARKETING_OFFICER' ? officerItems : allItems
  return <div className="flex min-h-[calc(100vh-64px)] flex-col md:flex-row">
    <aside className="bg-navy p-3 text-sm text-slate-200 md:w-56"><nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Admin">
      {items.map(i => <NavLink key={i} to={`/admin/${slug(i)}`} end className={({ isActive }) => `whitespace-nowrap rounded-lg px-3 py-2 ${isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10'}`}>{i}</NavLink>)}</nav></aside>
    <div className="flex-1"><div className="flex items-center justify-between border-b bg-white px-4 py-3 text-sm"><span>Signed in as <b>{role}</b></span><button className="btn-outline" onClick={async () => { await signOut(); nav('/') }}>Logout</button></div>
      <div className="p-4 md:p-8"><Routes>
        <Route index element={<Empty t="Dashboard" />} />
        <Route path="students" element={<Wrap t="Students"><AdminStudents /></Wrap>} />
        <Route path="loan-applications" element={<AdminLoanApplications />} />
        <Route path="loans" element={<Wrap t="Loans"><AdminLoans /></Wrap>} />
        <Route path="repayments" element={<Wrap t="Repayments"><AdminRepayments /></Wrap>} />
        <Route path="collections" element={<Wrap t="Collections"><AdminCollections /></Wrap>} />
        <Route path="marketing" element={<AdminMarketing />} />
        <Route path="reports" element={<Wrap t="Reports"><AdminReports /></Wrap>} />
        <Route path="settings" element={<Empty t="Settings" />} />
      </Routes></div></div></div>
}
