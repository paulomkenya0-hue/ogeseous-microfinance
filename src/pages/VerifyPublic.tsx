import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { describeError } from '../lib/api'
import { Badge, ErrorNote, STATUS_TONE, dateTime } from '../components/ui'
import { universityName } from '../config/site'

type Result = {
  application_number: string
  full_name: string
  university: string
  status: string
  submitted_at: string
}

/**
 * Anyone can reach this page, so the errors matter more than usual: a failed lookup and a
 * "not verified" answer used to look identical, because both left `result` null and the code never
 * read `error`. A scanner of a forged document could not have told the difference either.
 */
export default function VerifyPublic() {
  const [params] = useSearchParams()
  const [appNo, setAppNo] = useState(params.get('app') ?? '')
  const [token, setToken] = useState(params.get('token') ?? '')
  const [result, setResult] = useState<Result | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const verify = useCallback(async (number: string, code: string) => {
    setBusy(true)
    setChecked(false)
    setError('')
    try {
      const { data, error: e } = await supabase.rpc('get_application_verification', {
        p_app_number: number.trim(),
        p_token: code.trim(),
      })
      if (e) throw new Error(e.message)
      const row = (Array.isArray(data) ? data[0] : data) as Result | undefined
      setResult(row ?? null)
      setChecked(true)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [])

  // A scanned QR code arrives with both values in the URL, so check on arrival.
  useEffect(() => {
    const a = params.get('app')
    const t = params.get('token')
    if (a && t) void verify(a, t)
  }, [params, verify])

  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <h1 className="mb-1 text-2xl font-bold text-navy">Application Verification</h1>
      <p className="mb-6 text-sm text-slate-600">
        Confirm that a printed or shared OGESEOUS loan application is genuine. Both the application
        number and the verification code are needed — the code is printed under the QR code.
      </p>

      <div className="card space-y-3">
        <label className="block text-sm font-medium">
          Application Number
          <input
            className="input mt-1"
            value={appNo}
            onChange={(e) => setAppNo(e.target.value)}
            placeholder="OGE-2026-0001"
          />
        </label>
        <label className="block text-sm font-medium">
          Verification Code
          <input
            className="input mt-1"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button
          className="btn-blue w-full"
          disabled={busy || !appNo.trim() || !token.trim()}
          onClick={() => void verify(appNo, token)}
        >
          {busy ? 'Checking…' : 'Verify'}
        </button>
      </div>

      <ErrorNote error={error} />

      {checked && !error && (
        result ? (
          <div className="card mt-4 border-green-200 bg-green-50">
            <p className="font-semibold text-green-800">✓ Application verified</p>
            <p className="mt-2 text-sm">
              <b>Application no.:</b> {result.application_number}
            </p>
            <p className="text-sm">
              <b>Student name:</b> {result.full_name}
            </p>
            <p className="text-sm">
              <b>University:</b> {universityName(result.university)}
            </p>
            <p className="text-sm">
              <b>Status:</b> <Badge tone={STATUS_TONE[result.status]}>{result.status.replace('_', ' ')}</Badge>
            </p>
            <p className="text-sm">
              <b>Submitted:</b> {dateTime(result.submitted_at)}
            </p>
            <p className="mt-3 text-xs text-green-800">
              This confirms the application exists in OGESEOUS's records with these details. It does
              not confirm that a loan was approved or paid out — check with the office directly
              before acting on it.
            </p>
          </div>
        ) : (
          <div className="card mt-4 border-red-200 bg-red-50">
            <p className="font-semibold text-red-700">✗ Not verified</p>
            <p className="mt-1 text-sm text-red-700">
              No application matches that number and code together. Either the document is not
              genuine, or one of the two values has been mistyped.
            </p>
          </div>
        )
      )}
    </div>
  )
}