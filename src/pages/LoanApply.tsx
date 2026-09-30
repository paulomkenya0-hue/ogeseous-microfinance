import { useEffect, useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'

type Profile = { full_name: string; university: string | null; registration_number: string | null; verification_status: string }
type Draft = { amount: number; purpose: string; purpose_other: string | null; repayment_period_months: number; status: string } | null

const purposes = [
  ['TUITION_FEES', 'Tuition Fees'],
  ['ACCOMMODATION', 'Accommodation'],
  ['BOOKS_AND_MATERIALS', 'Books & Learning Materials'],
  ['OTHER', 'Other'],
] as const
const periods = [6, 12, 18, 24]

export default function LoanApply() {
  const { session } = useAuth()
  const nav = useNavigate()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState(''); const [purpose, setPurpose] = useState(''); const [purposeOther, setPurposeOther] = useState('')
  const [months, setMonths] = useState<number | ''>('')
  const [err, setErr] = useState<Record<string, string>>({}); const [saveMsg, setSaveMsg] = useState(''); const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([
      supabase.from('student_profiles').select('full_name,university,registration_number,verification_status').eq('user_id', session!.user.id).single(),
      supabase.from('loan_applications').select('amount,purpose,purpose_other,repayment_period_months,status').eq('user_id', session!.user.id).maybeSingle(),
    ]).then(([p, d]) => {
      setProfile(p.data as Profile)
      const draft = d.data as Draft
      if (draft) { setAmount(String(draft.amount)); setPurpose(draft.purpose); setPurposeOther(draft.purpose_other || ''); setMonths(draft.repayment_period_months) }
      setLoading(false)
    })
  }, [session])

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (profile && profile.verification_status !== 'VERIFIED') return <div className="mx-auto max-w-lg px-4 py-16 text-center">
    <div className="card"><h1 className="text-xl font-bold text-navy">Verification required</h1>
      <p className="mt-2 text-slate-600">You need to complete student verification before applying for a loan.</p>
      <button className="btn-blue mt-4" onClick={() => nav('/student/verify')}>Go to Verification</button></div></div>

  const saveDraft = async (e: FormEvent) => {
    e.preventDefault(); setSaveMsg(''); const x: Record<string, string> = {}
    const amt = Number(amount)
    if (!amount || isNaN(amt) || amt <= 0) x.amount = 'Enter a loan amount greater than 0'
    if (!purpose) x.purpose = 'Select a purpose'
    if (purpose === 'OTHER' && purposeOther.trim().length < 3) x.purposeOther = 'Describe the purpose'
    if (!months) x.months = 'Select a repayment period'
    setErr(x); if (Object.keys(x).length) return
    setBusy(true)
    const { error } = await supabase.rpc('save_loan_application_draft', {
      p_amount: amt, p_purpose: purpose, p_purpose_other: purpose === 'OTHER' ? purposeOther : null, p_repayment_months: months,
    })
    setBusy(false)
    setSaveMsg(error ? 'Could not save: ' + error.message : 'Draft saved.')
  }

  return <div className="mx-auto max-w-2xl px-4 py-10 space-y-6">
    <div><h1 className="text-2xl font-bold text-navy">Loan Application</h1>
      <p className="text-sm text-slate-600">Fill in your loan details below, then review and submit with Terms &amp; Conditions acceptance.</p></div>

    <div className="card">
      <h2 className="font-semibold text-navy">1. Personal Information</h2>
      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        <div><dt className="inline font-medium">Full Name: </dt><dd className="inline text-slate-600">{profile?.full_name}</dd></div>
        <div><dt className="inline font-medium">University: </dt><dd className="inline text-slate-600">{profile?.university}</dd></div>
        <div><dt className="inline font-medium">Registration No.: </dt><dd className="inline text-slate-600">{profile?.registration_number}</dd></div>
        <div><dt className="inline font-medium">Verification: </dt><dd className="inline text-green-700">Verified</dd></div>
      </dl>
      <p className="mt-2 text-xs text-slate-400">Pulled from your verified profile — edit it from Verification if anything is wrong.</p>
    </div>

    <form onSubmit={saveDraft} className="card space-y-3">
      <h2 className="font-semibold text-navy">2. Loan Details</h2>
      <label className="block text-sm font-medium">Amount Requested (TZS)
        <input className="input mt-1" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 1000000" />
        {err.amount && <span className="text-xs text-red-600">{err.amount}</span>}</label>
      <label className="block text-sm font-medium">Purpose
        <select className="input mt-1" value={purpose} onChange={e => setPurpose(e.target.value)}>
          <option value="">Select purpose</option>{purposes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {err.purpose && <span className="text-xs text-red-600">{err.purpose}</span>}</label>
      {purpose === 'OTHER' && <label className="block text-sm font-medium">Describe the purpose
        <input className="input mt-1" value={purposeOther} onChange={e => setPurposeOther(e.target.value)} />
        {err.purposeOther && <span className="text-xs text-red-600">{err.purposeOther}</span>}</label>}
      <label className="block text-sm font-medium">Repayment Period
        <select className="input mt-1" value={months} onChange={e => setMonths(Number(e.target.value))}>
          <option value="">Select repayment period</option>{periods.map(m => <option key={m} value={m}>{m} Months</option>)}</select>
        {err.months && <span className="text-xs text-red-600">{err.months}</span>}</label>
      {saveMsg && <p role="status" className="text-sm text-slate-700">{saveMsg}</p>}
      <button className="btn-blue w-full" disabled={busy}>{busy ? 'Saving…' : 'Save Draft'}</button>
    </form>

    <ReviewSubmit onSubmitted={() => nav('/student/application')} />
  </div>
}

function ReviewSubmit({ onSubmitted }: { onSubmitted: () => void }) {
  const { session } = useAuth()
  const [accepted, setAccepted] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const submit = async () => {
    setErr('')
    if (!accepted) return setErr('You must accept the Terms & Conditions to submit.')
    setBusy(true)
    const { data: app } = await supabase.from('loan_applications').select('id,status').eq('user_id', session!.user.id).maybeSingle()
    if (!app || app.status !== 'DRAFT') { setBusy(false); return setErr('Save your loan details as a draft first.') }
    const { error } = await supabase.rpc('submit_loan_application', { p_id: app.id, p_terms_accepted: true })
    setBusy(false)
    if (error) return setErr(error.message)
    onSubmitted()
  }
  return <div className="card">
    <h2 className="font-semibold text-navy">3. Review &amp; Submit</h2>
    <p className="mt-1 text-sm text-slate-600">Save your loan details above first, then accept the terms to submit.</p>
    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
      I confirm the information provided is accurate and I accept OGESEOUS Microfinance's Terms &amp; Conditions.</label>
    {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    <button className="btn-primary mt-3 w-full" disabled={busy || !accepted} onClick={submit}>{busy ? 'Submitting…' : 'Accept Terms & Submit Application'}</button>
  </div>
}
