import { useEffect, useState } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'

type Req = { id: string; university: string; method: string; registration_number: string; form_four_index_number: string; full_name_provided: string; status: string; created_at: string }

export default function AdminStudents() {
  const [rows, setRows] = useState<Req[]>([]); const [loading, setLoading] = useState(true); const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importMsg, setImportMsg] = useState(''); const [importing, setImporting] = useState(false)

  const load = () => { setLoading(true)
    supabase.from('verification_requests').select('id,university,method,registration_number,form_four_index_number,full_name_provided,status,created_at')
      .order('created_at', { ascending: false }).limit(200)
      .then(({ data, error }) => { if (error) setErr('Could not load verification requests.'); else setRows(data as Req[]); setLoading(false) }) }
  useEffect(load, [])

  const review = async (id: string, decision: 'VERIFIED' | 'REJECTED') => {
    const reason = decision === 'REJECTED' ? window.prompt('Reason for rejection (shown to the student):') || '' : null
    setBusyId(id)
    const { error } = await supabase.rpc('review_verification', { p_request_id: id, p_decision: decision, p_reason: reason })
    setBusyId(null)
    if (error) alert('Action failed: ' + error.message); else load()
  }

  const onFile = (file: File) => {
    setImportMsg(''); setImporting(true)
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: async (res) => {
      const required = ['form_four_index_number', 'registration_number', 'last_name', 'full_name']
      const headers = res.meta.fields || []
      if (!required.every(h => headers.includes(h))) {
        setImporting(false)
        return setImportMsg(`CSV must have columns: ${required.join(', ')}`)
      }
      const rows = (res.data as any[]).filter(r => r.form_four_index_number && r.registration_number)
      const { data, error } = await supabase.rpc('import_rucu_students', { p_rows: rows })
      setImporting(false)
      setImportMsg(error ? 'Import failed: ' + error.message : `Imported/updated ${data} student record(s).`)
    }, error: () => { setImporting(false); setImportMsg('Could not read that file.') } })
  }

  const badge = (s: string) => ({ PENDING: 'bg-amber-100 text-amber-800', VERIFIED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800' } as Record<string, string>)[s] || 'bg-slate-100'

  return <div className="space-y-6">
    <div className="card">
      <h2 className="font-semibold text-navy">Import RUCU Student Database</h2>
      <p className="mt-1 text-sm text-slate-600">CSV with columns: form_four_index_number, registration_number, last_name, full_name.</p>
      <input type="file" accept=".csv" className="input mt-3" disabled={importing} onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
      {importMsg && <p className="mt-2 text-sm">{importMsg}</p>}
    </div>

    <div className="card">
      <h2 className="mb-3 font-semibold text-navy">Verification Requests</h2>
      {loading && <p className="text-slate-500">Loading…</p>}
      {err && <p className="text-red-600">{err}</p>}
      {!loading && !err && rows.length === 0 && <p className="text-slate-600">No verification requests yet.</p>}
      {!loading && rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b text-slate-500"><th className="py-2 pr-3">Name</th><th className="py-2 pr-3">University</th><th className="py-2 pr-3">Reg No.</th><th className="py-2 pr-3">Method</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Action</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className="border-b last:border-0">
          <td className="py-2 pr-3">{r.full_name_provided}</td><td className="py-2 pr-3">{r.university}</td><td className="py-2 pr-3">{r.registration_number}</td>
          <td className="py-2 pr-3">{r.method === 'RUCU_AUTO' ? 'Auto-matched' : 'Manual'}</td>
          <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${badge(r.status)}`}>{r.status}</span></td>
          <td className="py-2 pr-3">{r.status === 'PENDING' ? <div className="flex gap-2">
            <button className="btn-primary px-3 py-1 text-xs" disabled={busyId === r.id} onClick={() => review(r.id, 'VERIFIED')}>Approve</button>
            <button className="btn border border-red-300 px-3 py-1 text-xs text-red-700" disabled={busyId === r.id} onClick={() => review(r.id, 'REJECTED')}>Reject</button></div>
            : <span className="text-xs text-slate-400">Reviewed</span>}</td></tr>)}</tbody></table></div>}
    </div>
  </div>
}
