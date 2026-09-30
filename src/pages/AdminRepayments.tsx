import { useEffect, useState, FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Loan = { id: string; outstanding_balance: number; status: string }

export default function AdminRepayments() {
  const [loans, setLoans] = useState<Loan[]>([])
  const [loanId, setLoanId] = useState(''); const [amount, setAmount] = useState(''); const [method, setMethod] = useState('CASH'); const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')

  const load = () => supabase.from('loans').select('id,outstanding_balance,status').eq('status', 'ACTIVE').then(({ data }) => setLoans((data || []) as Loan[]))
  useEffect(() => { load() }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg('')
    if (!loanId || !amount || Number(amount) <= 0) return setMsg('Select a loan and enter a valid amount.')
    setBusy(true)
    const { error } = await supabase.rpc('record_repayment', { p_loan_id: loanId, p_amount: Number(amount), p_method: method, p_reference: ref || null })
    setBusy(false)
    setMsg(error ? 'Failed: ' + error.message : 'Repayment recorded.')
    if (!error) { setAmount(''); setRef(''); load() }
  }

  return <div className="card">
    <h2 className="mb-3 font-semibold text-navy">Record Repayment</h2>
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm font-medium sm:col-span-2">Loan
        <select className="input mt-1" value={loanId} onChange={e => setLoanId(e.target.value)}>
          <option value="">Select an active loan</option>
          {loans.map(l => <option key={l.id} value={l.id}>{l.id.slice(0, 8)} — outstanding TZS {Number(l.outstanding_balance).toLocaleString()}</option>)}
        </select></label>
      <label className="block text-sm font-medium">Amount (TZS)<input className="input mt-1" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="block text-sm font-medium">Method
        <select className="input mt-1" value={method} onChange={e => setMethod(e.target.value)}>
          <option value="CASH">Cash</option><option value="MOBILE_MONEY">Mobile Money</option><option value="BANK_TRANSFER">Bank Transfer</option></select></label>
      <label className="block text-sm font-medium sm:col-span-2">Reference (optional)<input className="input mt-1" value={ref} onChange={e => setRef(e.target.value)} /></label>
      {msg && <p className="text-sm sm:col-span-2">{msg}</p>}
      <button className="btn-primary sm:col-span-2" disabled={busy}>{busy ? 'Recording…' : 'Record Repayment'}</button>
    </form>
  </div>
}
