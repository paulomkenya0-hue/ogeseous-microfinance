import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import { strongPw, PW_HINT, hasErrors, type Errors } from '../lib/validate'

/**
 * The reset email existed and the page did not. supabase.auth.resetPasswordForEmail() in Auth.tsx
 * mailed a working link to a URL with no route behind it, so a student who forgot their password
 * had no way to get back in except emailing the institution.
 *
 * Supabase puts the recovery token in the URL fragment and exchanges it for a session before this
 * component mounts, so the only thing to check is whether that session exists.
 */
export default function ResetPassword() {
  const { session, loading, clearRecovery } = useAuth()
  const nav = useNavigate()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<Errors>({})
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')

    const next: Errors = {}
    if (!strongPw(pw)) next.pw = PW_HINT
    if (pw !== pw2) next.pw2 = 'Passwords do not match'
    setErr(next)
    if (hasErrors(next)) return

    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) {
      setMsg('')
      setErr({ form: describeError(error) })
      return
    }
    clearRecovery()
    setMsg('Password updated. You are signed in.')
    setTimeout(() => nav('/login', { replace: true }), 1200)
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>

  // No recovery session: the link is missing, expired, or was opened in a different browser.
  if (!session) {
    return (
      <Shell title="Reset link expired">
        <p className="text-sm text-slate-600">
          This password reset link is no longer valid. Reset links expire and can only be used once.
          Request a new one from the login page.
        </p>
        <Link className="btn-blue mt-4 block text-center" to="/login">
          Back to login
        </Link>
      </Shell>
    )
  }

  return (
    <Shell title="Choose a new password">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <label className="block text-sm font-medium">
          New password
          <input
            type="password"
            className="input mt-1"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
          />
          <span className="mt-1 block text-xs text-slate-500">{PW_HINT}</span>
          {err.pw && (
            <span role="alert" className="text-xs text-red-600">
              {err.pw}
            </span>
          )}
        </label>
        <label className="block text-sm font-medium">
          Confirm new password
          <input
            type="password"
            className="input mt-1"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            autoComplete="new-password"
          />
          {err.pw2 && (
            <span role="alert" className="text-xs text-red-600">
              {err.pw2}
            </span>
          )}
        </label>
        {err.form && (
          <p role="alert" className="text-sm text-red-600">
            {err.form}
          </p>
        )}
        {msg && (
          <p role="status" className="text-sm text-green-700">
            {msg}
          </p>
        )}
        <button className="btn-blue w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </Shell>
  )
}

const Shell = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mx-auto max-w-md px-4 py-12">
    <div className="card">
      <h1 className="mb-4 text-2xl font-bold text-navy">{title}</h1>
      {children}
    </div>
  </div>
)
