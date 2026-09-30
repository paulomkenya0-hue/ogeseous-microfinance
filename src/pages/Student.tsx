import { useEffect, useState } from 'react'; import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'; import { useAuth } from '../auth/AuthContext'

function ReferralPrompt({ userId }: { userId: string }) {
  const [answered, setAnswered] = useState<boolean | null>(null)
  const [source, setSource] = useState<'' | 'STUDENTS' | 'GOOGLE' | 'MARKETING_OFFICER'>('')
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('')

  useEffect(() => { supabase.from('referral_captures').select('id').eq('student_user_id', userId).maybeSingle()
    .then(({ data }) => setAnswered(!!data)) }, [userId])

  const submit = async () => {
    setErr('')
    if (!source) return setErr('Please choose an option.')
    if (source === 'MARKETING_OFFICER' && !code.trim()) return setErr('Enter the marketing officer\u2019s referral number.')
    setBusy(true)
    const { error } = await supabase.rpc('submit_referral', { p_source: source, p_code: source === 'MARKETING_OFFICER' ? code : null })
    setBusy(false)
    if (error) setErr(error.message || 'That referral number was not recognized.'); else setAnswered(true)
  }

  if (answered === null || answered === true) return null
  return <div className="card">
    <h2 className="font-semibold">How did you hear about OGESEOUS?</h2>
    <div className="mt-2 space-y-2 text-sm">
      {[['STUDENTS', '1. Wanafunzi wenzangu (Fellow students)'], ['GOOGLE', '2. Google'], ['MARKETING_OFFICER', '3. Afisa Masoko (Marketing Officer)']].map(([v, l]) =>
        <label key={v} className="flex items-center gap-2"><input type="radio" name="ref" checked={source === v} onChange={() => setSource(v as any)} />{l}</label>)}
      {source === 'MARKETING_OFFICER' && <input className="input" placeholder="Enter referral number, e.g. OG-RUCU-A1B2C" value={code} onChange={e => setCode(e.target.value)} />}
      {err && <p className="text-red-600">{err}</p>}
      <button className="btn-blue" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Submit'}</button>
    </div>
  </div>
}

type Profile = { full_name: string; verification_status: 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED'; university: string | null }
type ReqRow = { status: string; rejection_reason: string | null }
type LoanRow = { status: string } | null
const loanLabel: Record<string, string> = { DRAFT: 'Draft saved', SUBMITTED: 'Submitted — awaiting review', UNDER_REVIEW: 'Under review', APPROVED: 'Approved — awaiting disbursement', REJECTED: 'Rejected', DISBURSED: 'Disbursed', CLOSED: 'Closed' }

const statusCopy: Record<Profile['verification_status'], { label: string; tone: string }> = {
  NOT_STARTED: { label: 'Not started', tone: 'bg-slate-100 text-slate-700' },
  PENDING: { label: 'Under review', tone: 'bg-amber-100 text-amber-800' },
  VERIFIED: { label: 'Verified', tone: 'bg-green-100 text-green-800' },
  REJECTED: { label: 'Rejected', tone: 'bg-red-100 text-red-700' },
}

export default function StudentDashboard() {
  const { session } = useAuth()
  const [p, setP] = useState<Profile | null>(null); const [req, setReq] = useState<ReqRow | null>(null); const [loan, setLoan] = useState<LoanRow>(null); const [err, setErr] = useState(false)

  useEffect(() => {
    supabase.from('student_profiles').select('full_name,verification_status,university').eq('user_id', session!.user.id).single()
      .then(({ data, error }) => error ? setErr(true) : setP(data as Profile))
    supabase.from('verification_requests').select('status,rejection_reason').eq('user_id', session!.user.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setReq(data as ReqRow | null))
    supabase.from('loan_applications').select('status').eq('user_id', session!.user.id).maybeSingle()
      .then(({ data }) => setLoan(data as LoanRow))
  }, [session])

  const hasApp = !!loan && loan.status !== 'DRAFT'
  const disbursed = loan?.status === 'DISBURSED' || loan?.status === 'CLOSED'
  const actions: [string, string | null][] = [
    ['My Applications', hasApp ? '/student/application' : null],
    ['My Documents', null],
    ['My Loan', disbursed ? '/student/loan' : null],
    ['Repayments', disbursed ? '/student/loan' : null],
    ['Download Forms', hasApp ? '/student/application' : null],
    ['Profile', null],
    ['Notifications', null],
  ]
  if (err) return <p className="p-10 text-center text-red-600">Could not load your profile. Please refresh.</p>
  if (!p) return <p className="p-10 text-center text-slate-500">Loading…</p>
  const s = statusCopy[p.verification_status]
  const pct = p.verification_status === 'VERIFIED' ? 100 : p.verification_status === 'PENDING' ? 60 : p.verification_status === 'REJECTED' ? 40 : 20

  return <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
    <h1 className="text-2xl font-bold text-navy">Welcome{p.full_name ? `, ${p.full_name}` : ''}</h1>
    <div className="grid gap-4 md:grid-cols-3">
      <div className="card"><h2 className="font-semibold">Profile completion</h2><div className="mt-3 h-2 rounded bg-slate-200"><div className="h-2 rounded bg-accent" style={{ width: `${pct}%` }} /></div>
        <p className="mt-2 text-xs text-slate-500">Full profile unlocks as verification and loan steps are completed.</p></div>
      <div className="card"><h2 className="font-semibold">Verification status</h2><span className={`mt-2 inline-block rounded-full px-3 py-1 text-sm ${s.tone}`}>{s.label}</span>
        {p.verification_status === 'REJECTED' && req?.rejection_reason && <p className="mt-2 text-xs text-red-600">Reason: {req.rejection_reason}</p>}
        {(p.verification_status === 'NOT_STARTED' || p.verification_status === 'REJECTED') && <Link to="/student/verify" className="btn-primary mt-3 block text-center">{p.verification_status === 'REJECTED' ? 'Resubmit Verification' : 'Start Verification'}</Link>}
        {p.verification_status === 'PENDING' && <p className="mt-2 text-xs text-slate-500">Your documents are being reviewed by OGESEOUS staff.</p>}</div>
      <div className="card"><h2 className="font-semibold">Loan application</h2>
        {loan ? <><p className="mt-2 text-sm text-slate-600">{loanLabel[loan.status] || loan.status}</p>
              <Link to={loan.status === 'DRAFT' ? '/student/apply' : '/student/application'} className="btn-outline mt-2 block text-center">{loan.status === 'DRAFT' ? 'Continue Application' : 'View Application'}</Link>
              {loan.status === 'DISBURSED' && <Link to="/student/loan" className="btn-primary mt-2 block text-center">View My Loan</Link>}</>
          : <><p className="mt-2 text-sm text-slate-600">No loan application submitted yet.</p>
              {p.verification_status === 'VERIFIED' ? <Link to="/student/apply" className="btn-primary mt-2 block text-center">Apply for Loan</Link>
                : <p className="mt-1 text-xs text-slate-400">Complete verification first.</p>}</>}</div>
    </div>
    <ReferralPrompt userId={session!.user.id} />
    <div className="card"><h2 className="font-semibold">Notifications</h2><p className="mt-2 text-sm text-slate-600">No notifications yet.</p></div>
    <div className="card"><h2 className="mb-3 font-semibold">Quick Actions</h2><div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {actions.map(([a, to]) => to
        ? <Link key={a} to={to} className="btn border border-navy text-navy hover:bg-slate-100">{a}</Link>
        : <button key={a} disabled title="Coming in a later development step" className="btn border border-slate-300 text-slate-500">{a}</button>)}</div></div>
  </div>
}
