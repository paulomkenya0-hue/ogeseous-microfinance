import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Row = { id: string; application_number: string; amount: number; purpose: string; status: string; submitted_at: string; user_id: string }

export default function AdminLoanApplications() {
  const [rows, setRows] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [busyId, setBusyId] = useState<string | null>(null)

  const load = () => supabase.from('loan_applications').select('id,application_number,amount,purpose,status,submitted_at,user_id')
    .not('status', 'eq', 'DRAFT').order('submitted_at', { ascending: false })
    .then(({ data }) => { setRows((data || []) as Row[]); setLoading(false) })
  useEffect(() => { load() }, [])

  const act = async (id: string, decision: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED') => {
    const notes = decision === 'REJECTED' ? window.prompt('Reason for rejection:') || '' : null
    setBusyId(id)
    const { error } = await supabase.rpc('review_loan_application', { p_id: id, p_decision: decision, p_notes: notes })
    setBusyId(null)
    if (error) alert('Failed: ' + error.message); else load()
  }
  const badge: Record<string, string> = { SUBMITTED: 'bg-amber-100 text-amber-800', UNDER_REVIEW: 'bg-blue-100 text-blue-800', APPROVED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800', DISBURSED: 'bg-slate-200 text-slate-700' }

  return <div className="card">
    <h2 className="mb-3 font-semibold text-navy">Loan Applications</h2>
    {loading ? <p className="text-slate-500">Loading…</p> : rows.length === 0 ? <p className="text-slate-600">No submitted applications yet.</p> :
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b text-slate-500"><th className="py-2 pr-3">App No.</th><th className="py-2 pr-3">Amount</th><th className="py-2 pr-3">Purpose</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Action</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className="border-b last:border-0">
          <td className="py-2 pr-3 font-mono">{r.application_number}</td><td className="py-2 pr-3">TZS {Number(r.amount).toLocaleString()}</td><td className="py-2 pr-3">{r.purpose}</td>
          <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${badge[r.status] || 'bg-slate-100'}`}>{r.status}</span></td>
          <td className="py-2 pr-3">{['SUBMITTED', 'UNDER_REVIEW'].includes(r.status) ? <div className="flex flex-wrap gap-1">
            {r.status === 'SUBMITTED' && <button className="btn-outline px-2 py-1 text-xs" disabled={busyId === r.id} onClick={() => act(r.id, 'UNDER_REVIEW')}>Review</button>}
            <button className="btn-primary px-2 py-1 text-xs" disabled={busyId === r.id} onClick={() => act(r.id, 'APPROVED')}>Approve</button>
            <button className="btn px-2 py-1 text-xs border border-red-300 text-red-700" disabled={busyId === r.id} onClick={() => act(r.id, 'REJECTED')}>Reject</button></div>
            : <span className="text-xs text-slate-400">—</span>}</td></tr>)}</tbody></table></div>}
  </div>
}
