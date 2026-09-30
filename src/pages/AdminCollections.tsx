import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Row = { loan_id: string; student_name: string; university: string; outstanding: number; due_date: string; days_overdue: number }

export default function AdminCollections() {
  const [rows, setRows] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null)

  const load = () => supabase.rpc('list_arrears').then(({ data }) => { setRows((data || []) as Row[]); setLoading(false) })
  useEffect(() => { load() }, [])

  const remind = async (loanId: string) => {
    const channel = window.prompt('Channel (SMS / EMAIL / CALL / VISIT):', 'SMS')
    if (!channel) return
    setBusy(loanId)
    const { error } = await supabase.rpc('log_reminder', { p_loan_id: loanId, p_channel: channel.toUpperCase() })
    setBusy(null)
    if (error) alert('Failed: ' + error.message)
    else alert('Reminder logged. Note: no real SMS/email is configured yet — this only records that contact was attempted.')
  }

  return <div className="card">
    <h2 className="mb-3 font-semibold text-navy">Arrears</h2>
    <p className="mb-3 text-xs text-slate-500">Due date = disbursement date + repayment period. No installment schedule yet.</p>
    {loading ? <p className="text-slate-500">Loading…</p> : rows.length === 0 ? <p className="text-slate-600">No loans in arrears.</p> :
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b text-slate-500"><th className="py-2 pr-3">Student</th><th className="py-2 pr-3">University</th><th className="py-2 pr-3">Outstanding</th><th className="py-2 pr-3">Due</th><th className="py-2 pr-3">Days Overdue</th><th className="py-2 pr-3">Action</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.loan_id} className="border-b last:border-0">
          <td className="py-2 pr-3">{r.student_name}</td><td className="py-2 pr-3">{r.university}</td><td className="py-2 pr-3">TZS {Number(r.outstanding).toLocaleString()}</td>
          <td className="py-2 pr-3">{r.due_date}</td><td className="py-2 pr-3 text-red-700">{r.days_overdue}</td>
          <td className="py-2 pr-3"><button className="btn-outline px-2 py-1 text-xs" disabled={busy === r.loan_id} onClick={() => remind(r.loan_id)}>Log Reminder</button></td></tr>)}</tbody></table></div>}
  </div>
}
