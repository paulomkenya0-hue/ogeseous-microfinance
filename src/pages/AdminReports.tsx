import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Stats = { total_students: number; verified_students: number; total_applications: number; submitted_applications: number; approved_applications: number; total_disbursed: number; total_collected: number; outstanding_portfolio: number; active_loans: number }
type Uni = { university: string; applications: number; approved: number }

export default function AdminReports() {
  const [s, setS] = useState<Stats | null>(null); const [uni, setUni] = useState<Uni[]>([]); const [loading, setLoading] = useState(true)

  useEffect(() => { Promise.all([supabase.rpc('get_dashboard_stats'), supabase.rpc('get_applications_by_university')]).then(([a, b]) => {
    setS((Array.isArray(a.data) ? a.data[0] : a.data) as Stats); setUni((b.data || []) as Uni[]); setLoading(false) }) }, [])

  if (loading) return <p className="text-slate-500">Loading…</p>
  if (!s) return <p className="text-slate-600">No report data available for your role.</p>
  const cards: [string, string][] = [
    ['Total Students', String(s.total_students)], ['Verified Students', String(s.verified_students)],
    ['Applications', String(s.total_applications)], ['Approved', String(s.approved_applications)],
    ['Active Loans', String(s.active_loans)], ['Total Disbursed', `TZS ${Number(s.total_disbursed).toLocaleString()}`],
    ['Total Collected', `TZS ${Number(s.total_collected).toLocaleString()}`], ['Outstanding Portfolio', `TZS ${Number(s.outstanding_portfolio).toLocaleString()}`],
  ]
  return <div className="space-y-6">
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([l, v]) => <div key={l} className="card"><p className="text-xs text-slate-500">{l}</p><p className="mt-1 text-xl font-bold text-navy">{v}</p></div>)}</div>
    <div className="card"><h2 className="mb-3 font-semibold text-navy">Applications by University</h2>
      {uni.length === 0 ? <p className="text-slate-600">No applications yet.</p> :
        <table className="w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2">University</th><th className="py-2">Applications</th><th className="py-2">Approved</th></tr></thead>
          <tbody>{uni.map(u => <tr key={u.university} className="border-b last:border-0"><td className="py-2">{u.university}</td><td className="py-2">{u.applications}</td><td className="py-2">{u.approved}</td></tr>)}</tbody></table>}
    </div>
  </div>
}
