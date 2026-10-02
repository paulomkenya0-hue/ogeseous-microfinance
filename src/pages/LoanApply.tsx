import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpcOne, tzs } from '../lib/api'
import { hasErrors, type Errors } from '../lib/validate'
import { universityName } from '../config/site'

type Profile = {
  full_name: string
  university: string | null
  registration_number: string | null
  verification_status: string
}
type Draft = { amount: number; purpose: string; purpose_other: string | null; repayment_period_months: number } | null
type Policy = {
  min_amount: number
  max_amount: number
  periods: number[]
  max_active_loans: number
  annual_interest_rate: number
  interest_convention: string
}

const PURPOSES: [string, string][] = [
  ['TUITION_FEES', 'Tuition fees'],
  ['ACCOMMODATION', 'Accommodation'],
  ['BOOKS_AND_MATERIALS', 'Books & learning materials'],
  ['OTHER', 'Other'],
]

const purposeLabel = (v: string, other: string | null) =>
  v === 'OTHER' ? other || 'Other' : PURPOSES.find(([code]) => code === v)?.[1] ?? v

export default function LoanApply() {
  const { session } = useAuth()
  const nav = useNavigate()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('')
  const [purposeOther, setPurposeOther] = useState('')
  const [months, setMonths] = useState<string>('')
  const [accepted, setAccepted] = useState(false)

  const [err, setErr] = useState<Errors>({})
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)

  useEffect(() => {
    if (!session) return
    let active = true

    const run = async () => {
      setLoading(true)
      setLoadError('')
      const uid = session.user.id
      const [p, d, pol] = await Promise.all([
        supabase
          .from('student_profiles')
          .select('full_name,university,registration_number,verification_status')
          .eq('user_id', uid)
          .single(),
        supabase
          .from('loan_applications')
          .select('amount,purpose,purpose_other,repayment_period_months,status')
          .eq('user_id', uid)
          .maybeSingle(),
        // Never let a missing policy block the form: the database enforces the limits anyway,
        // and the fields simply fall back to unconstrained placeholders.
        rpcOne<Policy>('loan_policy').catch(() => null),
      ])
      if (!active) return

      if (p.error) {
        // The old code treated a failed profile read as `profile === null`, and the verification
        // gate was `if (profile && status !== 'VERIFIED')` — so a failed read silently opened the
        // application form to an unverified student. A failed read is now an error, not a pass.
        setLoadError(describeError(p.error))
        setLoading(false)
        return
      }

      setProfile(p.data as Profile)
      if (d.data) {
        const existing = d.data as Draft & { status: string }
        setAmount(String(existing.amount))
        setPurpose(existing.purpose)
        setPurposeOther(existing.purpose_other ?? '')
        setMonths(String(existing.repayment_period_months))
        setDraft(existing)
        if (existing.status !== 'DRAFT') {
          nav('/student/application', { replace: true })
          return
        }
      }
      setPolicy(pol)
      setLoading(false)
    }

    void run()
    return () => {
      active = false
    }
  }, [session, nav])

  const amountNumber = Number(amount)
  const monthsNumber = months ? Number(months) : 0

  const validate = useCallback((): Errors => {
    const next: Errors = {}
    if (!amount.trim()) next.amount = 'Enter the amount you need'
    else if (!Number.isFinite(amountNumber) || amountNumber <= 0) next.amount = 'Enter a number greater than zero'
    else if (policy?.min_amount && amountNumber < policy.min_amount) next.amount = `The minimum loan is ${tzs(policy.min_amount)}`
    else if (policy?.max_amount && amountNumber > policy.max_amount) next.amount = `The maximum loan is ${tzs(policy.max_amount)}`
    if (!purpose) next.purpose = 'Select what the loan is for'
    if (purpose === 'OTHER' && purposeOther.trim().length < 3) next.purposeOther = 'Describe what the loan is for'
    if (!months) next.months = 'Select a repayment period'
    else if (policy?.periods?.length && !policy.periods.includes(monthsNumber)) {
      next.months = 'That repayment period is not offered'
    }
    return next
  }, [amount, amountNumber, months, monthsNumber, policy, purpose, purposeOther])

  const saveDraft = async (): Promise<string | null> => {
    const { error } = await supabase.rpc('save_loan_application_draft', {
      p_amount: amountNumber,
      p_purpose: purpose,
      p_purpose_other: purpose === 'OTHER' ? purposeOther : null,
      p_repayment_months: monthsNumber,
    })
    return error ? describeError(error) : null
  }

  const onSave = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')
    const next = validate()
    setErr(next)
    if (hasErrors(next)) return

    setBusy('save')
    const failure = await saveDraft()
    setBusy(null)
    if (failure) return setMsg(failure)
    setMsg('Draft saved. You can come back to it any time before submitting.')
  }

  /**
   * Save and submit in one action.
   *
   * This used to be a separate component that re-read the stored draft and submitted that. So a
   * student who edited the amount and pressed "Accept Terms & Submit" without saving first had
   * their earlier figures submitted — the review step showed one set of numbers and the
   * application contained another. Now submission always writes the form's current values first.
   */
  const onSubmit = async () => {
    setMsg('')
    if (!accepted) return setMsg('You must accept the Terms & Conditions to submit.')
    const next = validate()
    setErr(next)
    if (hasErrors(next)) return

    setBusy('submit')
    const saveFailure = await saveDraft()
    if (saveFailure) {
      setBusy(null)
      return setMsg(saveFailure)
    }

    const id = (await supabase
      .from('loan_applications')
      .select('id')
      .eq('user_id', session!.user.id)
      .eq('status', 'DRAFT')
      .maybeSingle()).data

    if (!id) {
      setBusy(null)
      return setMsg('We could not confirm your draft was saved. Please try again.')
    }

    const { error } = await supabase.rpc('submit_loan_application', { p_id: id.id, p_terms_accepted: true })
    setBusy(null)
    if (error) return setMsg(describeError(error))
    nav('/student/application')
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>

  if (loadError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">We could not load your application</h1>
          <p className="mt-2 text-sm text-slate-600">{loadError}</p>
          <button className="btn-blue mt-4" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const verified = profile?.verification_status === 'VERIFIED'
  if (!verified) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">Verification required</h1>
          <p className="mt-2 text-slate-600">
            {profile?.verification_status === 'PENDING'
              ? 'Your documents are still being reviewed by OGESEOUS staff. You can apply once that is complete.'
              : 'Complete student verification before applying for a loan.'}
          </p>
          {profile?.verification_status !== 'PENDING' && (
            <button className="btn-blue mt-4" onClick={() => nav('/student/verify')}>
              Go to verification
            </button>
          )}
        </div>
      </div>
    )
  }

  const periods = policy?.periods?.length ? policy.periods : [6, 12, 18, 24]
  const total = amountNumber > 0 && monthsNumber > 0 ? (amountNumber / monthsNumber) * 1.0 : 0

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-navy">Loan Application</h1>
        <p className="mt-1 text-sm text-slate-600">
          Fill in your loan details, then review and accept the Terms &amp; Conditions to submit.
        </p>
      </div>

      <div className="card">
        <h2 className="font-semibold text-navy">1. Student details</h2>
        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Full name: </dt>
            <dd className="inline text-slate-600">{profile?.full_name}</dd>
          </div>
          <div>
            <dt className="inline font-medium">University: </dt>
            <dd className="inline text-slate-600">{universityName(profile?.university)}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Registration no.: </dt>
            <dd className="inline text-slate-600">{profile?.registration_number ?? '—'}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Verification: </dt>
            {/* Was hard-coded to the word "Verified" regardless of the real status. */}
            <dd className="inline text-green-700">{profile?.verification_status}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-slate-400">
          Taken from your verified record. If any of it is wrong, contact OGESEOUS — it cannot be
          edited here, deliberately, so the application always matches what was verified.
        </p>
      </div>

      <form onSubmit={onSave} className="card space-y-3" noValidate>
        <h2 className="font-semibold text-navy">2. Loan details</h2>

        <label className="block text-sm font-medium">
          Amount requested (TZS)
          <input
            className="input mt-1"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="e.g. 1000000"
          />
          {policy?.min_amount ? (
            <span className="mt-1 block text-xs text-slate-500">
              Between {tzs(policy.min_amount)} and {tzs(policy.max_amount)}.
            </span>
          ) : null}
          {err.amount && <span className="text-xs text-red-600">{err.amount}</span>}
        </label>

        <label className="block text-sm font-medium">
          Purpose
          <select className="input mt-1" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">Select a purpose</option>
            {PURPOSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {err.purpose && <span className="text-xs text-red-600">{err.purpose}</span>}
        </label>

        {purpose === 'OTHER' && (
          <label className="block text-sm font-medium">
            Describe the purpose
            <input
              className="input mt-1"
              value={purposeOther}
              onChange={(e) => setPurposeOther(e.target.value)}
              maxLength={200}
            />
            {err.purposeOther && <span className="text-xs text-red-600">{err.purposeOther}</span>}
          </label>
        )}

        <label className="block text-sm font-medium">
          Repayment period
          <select className="input mt-1" value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="">Select a repayment period</option>
            {periods.map((m) => (
              <option key={m} value={m}>
                {m} months
              </option>
            ))}
          </select>
          {err.months && <span className="text-xs text-red-600">{err.months}</span>}
        </label>

        {total > 0 && (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            Roughly {tzs(Math.round(total))} a month over {months} months.
            {policy && policy.annual_interest_rate > 0 && (
              <> Interest at {policy.annual_interest_rate}% a year ({policy.interest_convention.toLowerCase().replace('_', ' ')}) applies.</>
            )}
          </p>
        )}

        {msg && (
          <p role="alert" className="text-sm text-red-600">
            {msg}
          </p>
        )}

        <button className="btn-blue w-full" disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save draft'}
        </button>
      </form>

      <div className="card">
        <h2 className="font-semibold text-navy">3. Review and submit</h2>

        {amountNumber > 0 && purpose && months ? (
          <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="inline font-medium">Amount: </dt>
              <dd className="inline text-slate-600">{tzs(amountNumber)}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Purpose: </dt>
              <dd className="inline text-slate-600">{purposeLabel(purpose, purposeOther)}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Repayment period: </dt>
              <dd className="inline text-slate-600">{months} months</dd>
            </div>
            <div>
              <dt className="inline font-medium">
                Active loans allowed:{' '}
              </dt>
              <dd className="inline text-slate-600">{policy?.max_active_loans ?? 1}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-slate-600">Complete the details above to review them here.</p>
        )}

        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            I confirm the information provided is accurate and I accept OGESEOUS Microfinance’s{' '}
            {/* Link, not a plain href: /terms is an in-app route, and an origin-rooted href
                404s wherever the app is served from a sub-path. */}
            <Link className="text-brand underline" to="/terms" target="_blank" rel="noreferrer">
              Terms &amp; Conditions
            </Link>
            .
          </span>
        </label>

        <button className="btn-primary mt-3 w-full" disabled={busy !== null || !accepted} onClick={() => void onSubmit()}>
          {busy === 'submit' ? 'Submitting…' : 'Accept terms and submit application'}
        </button>

        <p className="mt-2 text-xs text-slate-400">
          Submitting saves the details shown above first, so the application always matches what you
          see. Once submitted it cannot be edited — contact OGESEOUS if something needs to change.
        </p>
      </div>

      {draft && (
        <p className="text-xs text-slate-400">
          You have a saved draft. Submitting replaces it with whatever is in the form above.
        </p>
      )}
    </div>
  )
}
