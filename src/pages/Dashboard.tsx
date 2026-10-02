import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, tzs } from '../lib/api'
import { Badge, Card, ErrorNote, Money, STATUS_TONE, dateTime } from '../components/ui'
import { NOT_APPLIED, STATUS_EXPLAIN, STATUS_LABEL, purposeText } from '../lib/application'

type Profile = {
  full_name: string
  university: string | null
  programme: string | null
  year_of_study: string | null
  registration_number: string | null
}
type Account = { status: string }
type Application = {
  id: string
  application_number: string | null
  status: string
  amount: number | null
  purpose: string | null
  purpose_other: string | null
  repayment_period_months: number | null
  submitted_at: string | null
  updated_at: string
  review_notes: string | null
  action_required_note: string | null
}
type Loan = { id: string; status: string; outstanding_balance: number }

/**
 * How did you hear about us? Kept from the original dashboard because the referral capture is a
 * live marketing metric. On error it hides rather than nagging someone whose answer we failed to
 * read — a broken prompt is worse than a missing one.
 */
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
    <Card title="How did you hear about OGESEOUS?">
      <div className="space-y-2 text-sm">
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
    </Card>
  )
}

/**
 * The student's home page.
 *
 * Answers, in order: who am I, is my account working, where is my application, and what do I do
 * next. Everything else on the page is secondary.
 *
 * The application status shown here comes from the row itself. It is deliberately not derived from
 * student_profiles.verification_status: "this student is real" and "this loan was approved" are
 * separate facts and the old dashboard used to blur them into one progress bar that could read 100%
 * for a student with no application at all.
 */
export default function Dashboard() {
  const { session } = useAuth()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [application, setApplication] = useState<Application | null>(null)
  const [loan, setLoan] = useState<Loan | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [resubmitting, setResubmitting] = useState(false)
  const [actionError, setActionError] = useState('')

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const uid = session.user.id
      const [p, u, a, l] = await Promise.all([
        supabase
          .from('student_profiles')
          .select('full_name,university,programme,year_of_study,registration_number')
          .eq('user_id', uid)
          .single(),
        supabase.from('users').select('status').eq('id', uid).maybeSingle(),
        supabase
          .from('loan_applications')
          .select(
            'id,application_number,status,amount,purpose,purpose_other,repayment_period_months,submitted_at,updated_at,review_notes,action_required_note',
          )
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(1),
        supabase.from('loans').select('id,status,outstanding_balance').eq('user_id', uid).maybeSingle(),
      ])
      // The profile is the one read that must succeed. The rest are decoration: failing them should
      // not blank the whole dashboard the way a single throw used to.
      if (p.error) throw new Error(p.error.message)
      setProfile(p.data as Profile)
      setAccount(u.error ? null : ((u.data ?? null) as Account))

      // The newest application is the one that matters — whatever its status. An earlier draft or
      // rejection is history, and showing it as "your application" is how a student who was refused
      // ends up believing they are still under review. Only the newest row is read at all.
      const rows = (a.data ?? []) as Application[]
      setApplication(rows[0] ?? null)
      setLoan(l.error ? null : ((l.data ?? null) as Loan))
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
    setActionError('')
    const { error: e } = await supabase.rpc('delete_my_account')
    setDeleting(false)
    if (e) setActionError(describeError(e))
    else void load()
  }

  const resubmit = async () => {
    if (!application) return
    setResubmitting(true)
    setActionError('')
    const { error: e } = await supabase.rpc('resubmit_application', { p_id: application.id })
    setResubmitting(false)
    if (e) return setActionError(describeError(e))
    await load()
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (error && !profile) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Card title="We could not load your dashboard">
          <ErrorNote error={error} onRetry={() => void load()} />
          <Link className="btn-blue" to="/">
            Go home
          </Link>
        </Card>
      </div>
    )
  }
  if (!profile) return <p className="p-10 text-center text-slate-600">No profile found for this account.</p>

  const status = application?.status ?? NOT_APPLIED
  const isDraft = status === 'DRAFT'
  const actionRequired = status === 'ACTION_REQUIRED'
  const rejected = status === 'REJECTED'

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">
            Welcome{profile.full_name ? `, ${profile.full_name}` : ''}
          </h1>
          <p className="text-sm text-slate-600">{session?.user.email}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-slate-500">Student account status</p>
          <Badge tone={account?.status === 'ACTIVE' ? 'green' : 'red'}>
            {account?.status === 'ACTIVE' ? 'Active' : account?.status ?? 'Unknown'}
          </Badge>
        </div>
      </header>

      {error && <ErrorNote error={error} onRetry={() => void load()} />}
      {actionError && <ErrorNote error={actionError} />}

      <Card title="Loan application">
        {status === NOT_APPLIED ? (
          <>
            <p className="text-sm text-slate-600">{STATUS_EXPLAIN[NOT_APPLIED]}</p>
            <p className="mt-1 text-sm text-slate-600">
              Applying takes seven short steps. You can stop at any point and come back later — a
              part-finished application is saved, not lost.
            </p>
            <Link to="/loan/apply" className="btn-primary mt-4 inline-block">
              APPLY FOR LOAN
            </Link>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[status] ?? 'slate'}>{STATUS_LABEL[status] ?? status}</Badge>
              {isDraft && <span className="text-xs text-slate-500">Not submitted yet</span>}
            </div>
            <p className="mt-2 text-sm text-slate-600">{STATUS_EXPLAIN[status]}</p>

            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Application number</dt>
                <dd className="font-mono text-sm text-navy">{application?.application_number ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Amount</dt>
                <dd className="text-sm text-navy">
                  <Money value={application?.amount} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Submitted</dt>
                <dd className="text-sm text-navy">{application?.submitted_at ? dateTime(application.submitted_at) : 'Not yet'}</dd>
              </div>
              {application?.purpose && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Purpose</dt>
                  <dd className="text-sm text-navy">{purposeText(application.purpose, application.purpose_other)}</dd>
                </div>
              )}
            </dl>

            {actionRequired && application?.action_required_note && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">OGESEOUS needs something from you</p>
                <p className="mt-1">{application.action_required_note}</p>
                <p className="mt-1 text-xs">
                  If you have already sent it, or you would like to explain, call or visit the
                  office. Pressing the button below tells the officer the request has been dealt with.
                </p>
                <button className="btn-primary mt-3" disabled={resubmitting} onClick={() => void resubmit()}>
                  {resubmitting ? 'Sending…' : 'I have provided what was asked'}
                </button>
              </div>
            )}

            {rejected && application?.review_notes && (
              <p className="mt-3 text-sm text-slate-700">
                <span className="font-medium">Reason: </span>
                {application.review_notes}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {isDraft ? (
                <Link to="/loan/apply" className="btn-primary">
                  CONTINUE APPLICATION
                </Link>
              ) : (
                <Link to="/loan/application" className="btn-primary">
                  VIEW APPLICATION
                </Link>
              )}
              {rejected && (
                <Link to="/loan/apply" className="btn-outline">
                  APPLY AGAIN
                </Link>
              )}
              <Link to="/track" className="btn-outline">
                Track without signing in
              </Link>
            </div>

            {rejected && (
              <p className="mt-2 text-xs text-slate-500">
                You can apply again on this same account. Do not create a second one — two accounts
                means two profiles, and the documents and application you can see would be the ones
                attached to the other.
              </p>
            )}

            {isDraft && (
              <p className="mt-2 text-xs text-slate-500">
                Nothing here has been sent to OGESEOUS yet. Review is only started when you submit.
              </p>
            )}
          </>
        )}
      </Card>

      {loan && (
        <Card title="My loan">
          <p className="text-sm text-slate-600">
            {loan.status === 'CLOSED' ? 'Loan closed' : `${tzs(loan.outstanding_balance)} outstanding`}
          </p>
          <Link to="/loan/schedule" className="btn-outline mt-3 inline-block">
            VIEW MY LOAN
          </Link>
        </Card>
      )}

      <Card title="Your details">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Full name</dt>
            <dd className="text-sm text-navy">{profile.full_name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Registration number</dt>
            <dd className="text-sm text-navy">{profile.registration_number ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Programme</dt>
            <dd className="text-sm text-navy">{profile.programme ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Year of study</dt>
            <dd className="text-sm text-navy">{profile.year_of_study ?? '—'}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          Your name, university and registration number come from the register and cannot be edited
          here — that is what makes them worth trusting. Contact the office if one is wrong.
        </p>
      </Card>

      <ReferralPrompt userId={session!.user.id} />

      <Card title="Your data">
        <p className="text-sm text-slate-600">
          You can delete your account and everything in it while no loan is on record. Deleting is
          permanent.
        </p>
        <button
          className="btn mt-3 border border-red-300 text-red-700 disabled:opacity-50"
          disabled={deleting || !!loan}
          title={loan ? 'Settle or write off your loan before deleting your account' : undefined}
          onClick={() => void deleteAccount()}
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </Card>
    </div>
  )
}