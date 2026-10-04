import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { describeError, rpc } from '../lib/api'
import { Badge, ErrorNote, STATUS_TONE, dateTime } from '../components/ui'
import { STATUS_EXPLAIN, STATUS_LABEL } from '../lib/application'

type Result = {
  application_number: string
  status: string
  submitted_at: string | null
  updated_at: string
  masked_name: string
  action_required: boolean
  documents_needed: number
}

/**
 * Public application tracking, for somebody who is not signed in.
 *
 * Two things are required: the application number AND the phone number on the account. A screenshot
 * carries neither of them on its own, so the page cannot be used to look up a stranger's loan.
 *
 * What comes back is deliberately thin — a status, two dates, initials and a count of documents
 * still outstanding. Not the amount, not the full name, not the registration number, not the
 * university, not the purpose, not the guarantor. The database enforces that, not this component:
 * track_application() returns exactly these columns and no others, so there is nothing here to
 * accidentally render later.
 */
export default function TrackPublic() {
  const [params] = useSearchParams()
  const [number, setNumber] = useState(params.get('app') ?? '')
  const [phone, setPhone] = useState(params.get('phone') ?? '')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [miss, setMiss] = useState(false)

  const lookup = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setMiss(false)
    setResult(null)

    // Deliberately loose about format. The exact shape of a number is a business detail that could
    // change, and rejecting "that does not look right" here would help nobody — the server is the
    // only thing that can say whether a number exists. All this check does is stop an empty submit.
    if (number.trim().length < 6) {
      return setError('Enter your application number exactly as it was given to you.')
    }
    if (phone.replace(/\D/g, '').length < 9) {
      return setError('Enter the phone number on your account.')
    }

    setBusy(true)
    try {
      const rows = await rpc<Result>('track_application', {
        p_number: number.trim(),
        p_phone: phone.trim(),
      })
      // Zero rows is the answer to a wrong number OR a wrong phone. The page must not say which:
      // telling a caller "the number is right but the phone is wrong" turns this into an oracle for
      // guessing valid application numbers.
      if (rows.length === 0) {
        setMiss(true)
      } else {
        setResult(rows[0])
      }
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-bold text-navy">Track an application</h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter your application number together with the phone number on your account. You do not need
        to be signed in.
      </p>

      <form onSubmit={lookup} className="card mt-5 space-y-3" noValidate>
        <label className="block text-sm font-medium">
          Application number
          <input
            className="input mt-1 font-mono"
            placeholder="OGS-2026-000184"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="block text-sm font-medium">
          Phone number on the account
          <input
            className="input mt-1"
            inputMode="tel"
            placeholder="0755 000 000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
        </label>

        {error && <ErrorNote error={error} />}

        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Checking…' : 'Check status'}
        </button>
      </form>

      {miss && (
        <div className="card mt-4">
          <h2 className="font-semibold text-navy">No matching application</h2>
          <p className="mt-1 text-sm text-slate-600">
            We could not find an application with those two details together. Check the number for
            typing mistakes — it looks like <span className="font-mono">OGS-2026-000184</span> — and
            check that you are using the phone number on the account you applied with.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            If it still does not match, call or visit the OGESEOUS office rather than trying again:
            after many attempts this page stops answering for a while.
          </p>
        </div>
      )}

      {result && (
        <div className="card mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-navy">{result.application_number}</h2>
            <Badge tone={STATUS_TONE[result.status] ?? 'slate'}>{STATUS_LABEL[result.status] ?? result.status}</Badge>
          </div>

          {STATUS_EXPLAIN[result.status] && (
            <p className="text-sm text-slate-600">{STATUS_EXPLAIN[result.status]}</p>
          )}

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Student</dt>
              <dd className="text-navy">{result.masked_name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Submitted</dt>
              <dd className="text-navy">{dateTime(result.submitted_at)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Last updated</dt>
              <dd className="text-navy">{dateTime(result.updated_at)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Documents outstanding</dt>
              <dd className="text-navy">{result.documents_needed}</dd>
            </div>
          </dl>

          {result.action_required && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              OGESEOUS has asked you for something before this application can move on. Sign in to
              your account, or call the office, to see what.
            </div>
          )}

          <p className="text-xs text-slate-400">
            This page deliberately does not show the amount, your name, your registration number or
            your documents.
          </p>
        </div>
      )}

      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{' '}
        {/* Link, not an href: an origin-rooted href 404s wherever the app is served from a
            sub-path, which on GitHub Pages is every deployment. */}
        <Link className="text-brand underline" to="/login">
          Sign in
        </Link>{' '}
        to see the full application, including your uploaded documents.
      </p>
    </div>
  )
}