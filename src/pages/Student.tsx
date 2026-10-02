import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import { universityName } from '../config/site'
import { tzs } from '../lib/api'

type Profile = {
  full_name: string
  verification_status: 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED'
  university: string | null
}
type ReqRow = { status: string; rejection_reason: string | null } | null
type ApplicationRow = { status: string } | null
type LoanRow = { id: string; status: string; outstanding_balance: number } | null

const APPLICATION_LABEL: Record<string, string> = {
  DRAFT: 'Draft saved — not yet submitted',
  SUBMITTED: 'Submitted — awaiting review',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved — awaiting disbursement',
  REJECTED: 'Rejected',
  DISBURSED: 'Disbursed',
  CLOSED: 'Closed',
}

const STATUS_TONE: Record<Profile['verification_status'], string> = {
  NOT_STARTED: 'bg-slate-100 text-slate-700',
  PENDING: 'bg-amber-100 text-amber-800',
  VERIFIED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-700',
}

const STATUS_LABEL: Record<Profile['verification_status'], string> = {
  NOT_STARTED: 'Not started',
  PENDING: 'Under review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
}

/** Ordered so the newest request wins if a student has more than one. */
const pickNewest = <T extends { created_at?: string }>(rows: T[]): T | null =>
  rows.length === 0 ? null : rows.reduce((a, b) => ((a.created_at ?? '') >= (b.created_at ?? '') ? a : b))

function ReferralPrompt({ userId }: { userId: string }) {
  const [answered, setAnswered] = useState<boolean | null>(null)
  const [source, setSource] = useState<'STUDENTS' | 'GOOGLE' | 'MARKETING_OFFICER' | ''>('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let active = true
    supabase
      .from('referral_captures')
      .select('id')
      .eq('student_user_id', userId)
      .maybeSingle()
      .then(({ data, error: e }) => {
        if (!active) return
        // On error, hide the prompt rather than nagging someone whose answer we failed to read.
        setAnswered(e ? true : !!data)
      })
    return () => {
      active = false
    }
  }, [userId])

  const submit = async () => {
    setErr('')
    if (!source) return setErr('Please choose an option.')
    if (source === 'MARKETING_OFFICER' && !code.trim()) {
      return setErr('Enter the marketing officer’s referral number.')
    }
    setBusy(true)
    const { error } = await supabase.rpc('submit_referral', {
      p_source: source,
      p_code: source === 'MARKETING_OFFICER' ? code : null,
    })
    setBusy(false)
    if (error) return setErr(describeError(error))
    setAnswered(true)
  }

  if (answered !== false) return null

  const options: [typeof source, string][] = [
    ['STUDENTS', 'Fellow students'],
    ['GOOGLE', 'Google'],
    ['MARKETING_OFFICER', 'A marketing officer'],
  ]

  return (
    <div className="card">
      <h2 className="font-semibold">How did you hear about OGESEOUS?</h2>
      <div className="mt-2 space-y-2 text-sm">
        {options.map(([v, label]) => (
          <label key={v} className="flex items-center gap-2">
            <input type="radio" name="referral" checked={source === v} onChange={() => setSource(v)} />
            {label}
          </label>
        ))}
        {source === 'MARKETING_OFFICER' && (
          <input
            className="input"
            placeholder="Referral number, e.g. OG-RUCU-A1B2C"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        )}
        {err && <p className="text-red-600">{err}</p>}
        <button className="btn-blue" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default function StudentDashboard() {
  const { session } = useAuth()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [request, setRequest] = useState<ReqRow>(null)
  const [application, setApplication] = useState<ApplicationRow>(null)
  const [loan, setLoan] = useState<LoanRow>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const uid = session.user.id
      const [p, v, a, l] = await Promise.all([
        supabase.from('student_profiles').select('full_name,verification_status,university').eq('user_id', uid).single(),
        supabase.from('verification_requests').select('status,rejection_reason,created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(5),
        supabase.from('loan_applications').select('status').eq('user_id', uid).maybeSingle(),
        supabase.from('loans').select('id,status,outstanding_balance').eq('user_id', uid).maybeSingle(),
      ])
      // The profile is the one read that must succeed. The rest are decoration: failing them
      // should not blank the whole dashboard the way a single throw used to.
      if (p.error) throw new Error(p.error.message)
      setProfile(p.data as Profile)
      setRequest(pickNewest((v.data ?? []) as (ReqRow & { created_at?: string })[]) as ReqRow)
      setApplication(a.error ? null : ((a.data ?? null) as ApplicationRow))
      setLoan(l.error ? null : ((l.data ?? null) as LoanRow))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void load()
  }, [load])

  const deleteAccount = async () => {
    const confirmText =
      'This permanently deletes your account, profile and uploaded documents. It is only possible ' +
      'while no loan is on record. Continue?'
    if (!window.confirm(confirmText)) return
    setDeleting(true)
    const { error: e } = await supabase.rpc('delete_my_account')
    setDeleting(false)
    // On success Supabase signs the user out via the auth event, so the provider reroutes.
    if (e) setError(describeError(e))
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (error && !profile) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">We could not load your profile</h1>
          <p className="mt-2 text-sm text-slate-600">{error}</p>
          <button className="btn-blue mt-4" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (!profile) return <p className="p-10 text-center text-slate-600">No profile found for this account.</p>

  const vs = profile.verification_status
  const appStatus = application?.status ?? null
  const hasSubmitted = !!appStatus && appStatus !== 'DRAFT'
  const isRejected = appStatus === 'REJECTED'

  const actions: [string, string | null][] = [
    ['My application', hasSubmitted ? '/student/application' : appStatus === 'DRAFT' ? '/student/apply' : null],
    ['My loan', loan ? '/student/loan' : null],
    ['Repayment schedule', loan ? '/student/loan' : null],
    ['Student verification', vs === 'VERIFIED' ? null : vs === 'PENDING' ? null : '/student/verify'],
  ]

  const progress = vs === 'VERIFIED' ? (hasSubmitted ? 100 : 70) : vs === 'PENDING' ? 45 : vs === 'REJECTED' ? 30 : 15

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold text-navy">
        Welcome{profile.full_name ? `, ${profile.full_name}` : ''}
      </h1>

      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card">
          <h2 className="font-semibold">Progress</h2>
          <div className="mt-3 h-2 rounded bg-slate-200">
            <div className="h-2 rounded bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Verification unlocks loan applications. An application is reviewed by staff — approval is never automatic.
          </p>
        </div>

        <div className="card">
          <h2 className="font-semibold">Verification</h2>
          <span className={`mt-2 inline-block rounded-full px-3 py-1 text-sm ${STATUS_TONE[vs]}`}>
            {STATUS_LABEL[vs]}
          </span>
          {profile.university && <p className="mt-2 text-sm text-slate-600">{universityName(profile.university)}</p>}
          {vs === 'REJECTED' && request?.rejection_reason && (
            <p className="mt-2 text-xs text-red-600">Reason: {request.rejection_reason}</p>
          )}
          {(vs === 'NOT_STARTED' || vs === 'REJECTED') && (
            <Link to="/student/verify" className="btn-primary mt-3 block text-center">
              {vs === 'REJECTED' ? 'Resubmit verification' : 'Start verification'}
            </Link>
          )}
          {vs === 'PENDING' && (
            <p className="mt-2 text-xs text-slate-500">Your documents are with OGESEOUS staff for review.</p>
          )}
        </div>

        <div className="card">
          <h2 className="font-semibold">Loan</h2>
          {loan ? (
            <>
              <p className="mt-2 text-sm text-slate-600">
                {loan.status === 'CLOSED' ? 'Loan closed' : `${tzs(loan.outstanding_balance)} outstanding`}
              </p>
              <Link to="/student/loan" className="btn-outline mt-2 block text-center">
                View my loan
              </Link>
            </>
          ) : appStatus ? (
            <>
              <p className="mt-2 text-sm text-slate-600">{APPLICATION_LABEL[appStatus] ?? appStatus}</p>
              <Link
                to={appStatus === 'DRAFT' ? '/student/apply' : '/student/application'}
                className="btn-outline mt-2 block text-center"
              >
                {appStatus === 'DRAFT' ? 'Continue application' : 'View application'}
              </Link>
              {isRejected && request?.rejection_reason && (
                <p className="mt-2 text-xs text-slate-600">Contact the office if you would like this reviewed again.</p>
              )}
            </>
          ) : vs === 'VERIFIED' ? (
            <Link to="/student/apply" className="btn-primary mt-2 block text-center">
              Apply for a loan
            </Link>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">No application yet.</p>
              <p className="mt-1 text-xs text-slate-400">Complete verification first.</p>
            </>
          )}
        </div>
      </div>

      {session && <ReferralPrompt userId={session.user.id} />}

      <div className="card">
        <h2 className="mb-3 font-semibold">Quick links</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {actions.map(([label, to]) =>
            to ? (
              <Link key={label} to={to} className="btn border border-navy text-navy hover:bg-slate-100">
                {label}
              </Link>
            ) : (
              <span
                key={label}
                className="btn cursor-not-allowed border border-slate-200 text-slate-400"
                title="Not available yet"
              >
                {label}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="mb-1 font-semibold">Your data</h2>
        <p className="text-sm text-slate-600">
          Your verified name, university and registration number can only be changed by OGESEOUS
          staff, so that what appears on your application is what was verified.
        </p>
        <button
          className="btn mt-3 border border-red-300 text-red-700 disabled:opacity-50"
          disabled={deleting || !!loan}
          title={loan ? 'Settle or write off your loan before deleting your account' : undefined}
          onClick={() => void deleteAccount()}
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </div>
  )
}
