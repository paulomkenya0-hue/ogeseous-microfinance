import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

type Result = { application_number: string; full_name: string; university: string; status: string; submitted_at: string } | null

export default function VerifyPublic() {
  const [params] = useSearchParams()
  const [appNo, setAppNo] = useState(params.get('app') || '')
  const [token, setToken] = useState(params.get('token') || '')
  const [result, setResult] = useState<Result>(null); const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false)

  const verify = async () => {
    setBusy(true); setChecked(false)
    const { data } = await supabase.rpc('get_application_verification', { p_app_number: appNo.trim(), p_token: token.trim() })
    const row = Array.isArray(data) ? data[0] : data
    setResult(row || null); setChecked(true); setBusy(false)
  }
  useEffect(() => { if (params.get('app') && params.get('token')) verify() }, []) // eslint-disable-line

  return <div className="mx-auto max-w-lg px-4 py-12">
    <h1 className="mb-1 text-2xl font-bold text-navy">Application Verification</h1>
    <p className="mb-6 text-sm text-slate-600">Confirm that a printed or shared OGESEOUS loan application form is genuine.</p>
    <div className="card space-y-3">
      <label className="block text-sm font-medium">Application Number<input className="input mt-1" value={appNo} onChange={e => setAppNo(e.target.value)} placeholder="OGE-2026-0001" /></label>
      <label className="block text-sm font-medium">Verification Code (from the QR code)<input className="input mt-1" value={token} onChange={e => setToken(e.target.value)} /></label>
      <button className="btn-blue w-full" disabled={busy || !appNo || !token} onClick={verify}>{busy ? 'Checking…' : 'Verify'}</button>
    </div>
    {checked && (result
      ? <div className="card mt-4 border-green-200 bg-green-50">
          <p className="font-semibold text-green-800">✓ Application Verified</p>
          <p className="mt-2 text-sm"><b>Application No.:</b> {result.application_number}</p>
          <p className="text-sm"><b>Student Name:</b> {result.full_name}</p>
          <p className="text-sm"><b>University:</b> {result.university}</p>
          <p className="text-sm"><b>Status:</b> {result.status}</p>
          <p className="text-sm"><b>Date:</b> {new Date(result.submitted_at).toLocaleString()}</p>
        </div>
      : <div className="card mt-4 border-red-200 bg-red-50"><p className="font-semibold text-red-700">✗ Not Verified</p>
          <p className="mt-1 text-sm text-red-700">No matching application was found for this number and code.</p></div>)}
  </div>
}
