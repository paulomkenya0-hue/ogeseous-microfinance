import { useEffect, useState, FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { site } from '../config/site'

type Stat = { officer_id: string; full_name: string; university: string; referral_code: string; status: string; referrals: number }

export default function AdminMarketing() {
  const { role } = useAuth()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'MANAGER'
  const [stats, setStats] = useState<Stat[]>([]); const [loading, setLoading] = useState(true); const [err, setErr] = useState('')
  const [name, setName] = useState(''); const [uni, setUni] = useState(''); const [busy, setBusy] = useState(false); const [newCode, setNewCode] = useState('')

  const load = () => { setLoading(true)
    supabase.rpc('get_marketing_stats').then(({ data, error }) => { if (error) setErr('Could not load referral performance.'); else setStats((data || []) as Stat[]); setLoading(false) }) }
  useEffect(load, [])

  const create = async (e: FormEvent) => {
    e.preventDefault(); if (!name.trim() || !uni) return
    setBusy(true); setNewCode('')
    const { data, error } = await supabase.rpc('create_marketing_officer', { p_full_name: name, p_university: uni })
    setBusy(false)
    if (error) return alert('Could not create officer: ' + error.message)
    const row = Array.isArray(data) ? data[0] : data
    setNewCode(row.referral_code); setName(''); setUni(''); load()
  }

  const total = stats.reduce((s, r) => s + Number(r.referrals), 0)

  return <div className="space-y-6">
    <h1 className="text-2xl font-bold text-navy">Marketing {isAdmin ? '' : '— My Referral Code'}</h1>

    {isAdmin && <div className="card">
      <h2 className="font-semibold text-navy">Add Marketing Officer</h2>
      <form onSubmit={create} className="mt-3 grid gap-3 sm:grid-cols-3">
        <input className="input" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
        <select className="input" value={uni} onChange={e => setUni(e.target.value)}>
          <option value="">Select university</option>
          {site.universities.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}
        </select>
        <button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create & generate code'}</button>
      </form>
      {newCode && <p className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">Referral number created: <b>{newCode}</b>. Share this with the officer.</p>}
      <p className="mt-2 text-xs text-slate-500">A login account can be linked to an officer later once staff invitations are built; the referral code works immediately either way.</p>
    </div>}

    <div className="card">
      <h2 className="mb-3 font-semibold text-navy">{isAdmin ? 'Referral Performance — All Officers' : 'Your Performance'}</h2>
      {loading && <p className="text-slate-500">Loading…</p>}
      {err && <p className="text-red-600">{err}</p>}
      {!loading && !err && stats.length === 0 && <p className="text-slate-600">No marketing officers yet.</p>}
      {!loading && stats.length > 0 && <>
        {isAdmin && <p className="mb-3 text-sm text-slate-600">Total tracked sign-ups via marketing officers: <b>{total}</b></p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b text-slate-500"><th className="py-2 pr-3">Officer</th><th className="py-2 pr-3">University</th><th className="py-2 pr-3">Referral No.</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Referrals</th></tr></thead>
          <tbody>{stats.map(s => <tr key={s.officer_id} className="border-b last:border-0">
            <td className="py-2 pr-3">{s.full_name}</td><td className="py-2 pr-3">{s.university}</td>
            <td className="py-2 pr-3 font-mono">{s.referral_code}</td>
            <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${s.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>{s.status}</span></td>
            <td className="py-2 pr-3 font-semibold">{s.referrals}</td></tr>)}</tbody></table></div></>}
    </div>
  </div>
}
