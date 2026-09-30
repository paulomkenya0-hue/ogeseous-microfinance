import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'

type Loan = { id: string; principal_amount: number; outstanding_balance: number; status: string; disbursed_at: string }
type Repayment = { id: string; amount: number; method: string; paid_at: string }

export default function StudentLoan() {
  const { session } = useAuth()
  const [loan, setLoan] = useState<Loan | null>(null); const [reps, setReps] = useState<Repayment[]>([]); const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('loans').select('id,principal_amount,outstanding_balance,status,disbursed_at').eq('user_id', session!.user.id).maybeSingle()
      .then(({ data }) => {
        setLoan(data as Loan)
        if (data) supabase.from('repayments').select('id,amount,method,paid_at').eq('loan_id', (data as Loan).id).order('paid_at', { ascending: false })
          .then(({ data: r }) => { setReps((r || []) as Repayment[]); setLoading(false) })
        else setLoading(false)
      })
  }, [session])

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (!loan) return <div className="mx-auto max-w-lg px-4 py-16 text-center"><div className="card"><h1 className="text-xl font-bold text-navy">My Loan</h1>
    <p className="mt-2 text-slate-600">You don't have a disbursed loan yet.</p></div></div>

  return <div className="mx-auto max-w-2xl px-4 py-10 space-y-6">
    <h1 className="text-2xl font-bold text-navy">My Loan</h1>
    <div className="card grid gap-3 sm:grid-cols-3">
      <div><p className="text-xs text-slate-500">Principal</p><p className="text-lg font-semibold">TZS {Number(loan.principal_amount).toLocaleString()}</p></div>
      <div><p className="text-xs text-slate-500">Outstanding</p><p className="text-lg font-semibold text-accent">TZS {Number(loan.outstanding_balance).toLocaleString()}</p></div>
      <div><p className="text-xs text-slate-500">Status</p><p className="text-lg font-semibold">{loan.status}</p></div>
    </div>
    <div className="card">
      <h2 className="mb-3 font-semibold text-navy">Repayment History</h2>
      {reps.length === 0 ? <p className="text-sm text-slate-600">No repayments recorded yet.</p> :
        <table className="w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2">Date</th><th className="py-2">Amount</th><th className="py-2">Method</th></tr></thead>
          <tbody>{reps.map(r => <tr key={r.id} className="border-b last:border-0"><td className="py-2">{new Date(r.paid_at).toLocaleDateString()}</td><td className="py-2">TZS {Number(r.amount).toLocaleString()}</td><td className="py-2">{r.method}</td></tr>)}</tbody></table>}
    </div>
  </div>
}
