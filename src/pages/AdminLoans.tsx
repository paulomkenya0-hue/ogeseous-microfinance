import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Approved = { id: string; application_number: string; amount: number; user_id: string }
type Loan = { id: string; principal_amount: number; outstanding_balance: number; status: string; disbursed_at: string }

export default function AdminLoans() {
  const [approved, setApproved] = useState<Approved[]>([]); const [loans, setLoans] = useState<Loan[]>([]); const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    supabase.from('loan_applications').select('id,application_number,amount,user_id').eq('status', 'APPROVED').then(({ data }) => setApproved((data || []) as Approved[]))
    supabase.from('loans').select('id,principal_amount,outstanding_balance,status,disbursed_at').order('disbursed_at', { ascending: false }).then(({ data }) => setLoans((data || []) as Loan[]))
  }
  useEffect(load, [])

  const disburse = async (a: Approved) => {
    const input = window.prompt(`Disbursement amount for ${a.application_number} (TZS):`, String(a.amount))
    if (!input) return
    setBusy(a.id)
    const { error } = await supabase.rpc('disburse_loan', { p_application_id: a.id, p_amount: Number(input) })
    setBusy(null)
    if (error) alert('Failed: ' + error.message); else load()
  }

  return <div className="space-y-6">
    <div className="card"><h2 className="mb-3 font-semibold text-navy">Approved — Awaiting Disbursement</h2>
      {approved.length === 0 ? <p className="text-slate-600">Nothing awaiting disbursement.</p> : <div className="space-y-2">
        {approved.map(a => <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm">
          <span className="font-mono">{a.application_number} — TZS {Number(a.amount).toLocaleString()}</span>
          <button className="btn-primary px-3 py-1 text-xs" disabled={busy === a.id} onClick={() => disburse(a)}>{busy === a.id ? 'Disbursing…' : 'Disburse'}</button></div>)}</div>}
    </div>
    <div className="card"><h2 className="mb-3 font-semibold text-navy">Loans</h2>
      {loans.length === 0 ? <p className="text-slate-600">No loans disbursed yet.</p> :
        <table className="w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2 pr-3">Disbursed</th><th className="py-2 pr-3">Principal</th><th className="py-2 pr-3">Outstanding</th><th className="py-2 pr-3">Status</th></tr></thead>
        <tbody>{loans.map(l => <tr key={l.id} className="border-b last:border-0"><td className="py-2 pr-3">{new Date(l.disbursed_at).toLocaleDateString()}</td>
          <td className="py-2 pr-3">TZS {Number(l.principal_amount).toLocaleString()}</td><td className="py-2 pr-3">TZS {Number(l.outstanding_balance).toLocaleString()}</td><td className="py-2 pr-3">{l.status}</td></tr>)}</tbody></table>}
    </div>
  </div>
}
