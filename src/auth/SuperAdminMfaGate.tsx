import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { describeError } from '../lib/api'
import { supabase } from '../lib/supabase'

type GateState = 'loading' | 'setup' | 'enroll-code' | 'challenge' | 'ready'

export default function SuperAdminMfaGate({ children }: { children: ReactNode }) {
  const { session, signOut } = useAuth()
  const [state, setState] = useState<GateState>('loading')
  const [factorId, setFactorId] = useState('')
  const [pendingFactorId, setPendingFactorId] = useState('')
  const [qrCode, setQrCode] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true

    const inspectFactors = async () => {
      const [factorsResult, assuranceResult] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ])
      if (factorsResult.error) throw factorsResult.error
      if (assuranceResult.error) throw assuranceResult.error

      const factors = factorsResult.data.all.filter((factor) => factor.factor_type === 'totp')
      const verified = factors.find((factor) => factor.status === 'verified')
      const pending = factors.find((factor) => factor.status === 'unverified')
      if (pending) setPendingFactorId(pending.id)

      if (!verified) {
        setState('setup')
        return
      }

      setFactorId(verified.id)
      if (assuranceResult.data.currentLevel !== 'aal2') {
        setState('challenge')
        return
      }

      const { error: auditError } = await supabase.rpc('record_super_admin_mfa_event', {
        p_action: 'SUPER_ADMIN_MFA_VERIFIED',
      })
      if (auditError) throw auditError
      if (active) setState('ready')
    }

    void inspectFactors().catch((cause: unknown) => {
      if (active) {
        setError(describeError(cause))
        setState('setup')
      }
    })

    return () => {
      active = false
    }
  }, [session?.user.id])

  const startEnrollment = async () => {
    setBusy(true)
    setError('')
    try {
      if (pendingFactorId) {
        const { error: removeError } = await supabase.auth.mfa.unenroll({ factorId: pendingFactorId })
        if (removeError) throw removeError
        setPendingFactorId('')
      }
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'OGESEOUS Super Admin',
      })
      if (enrollError) throw enrollError
      setFactorId(data.id)
      setQrCode(data.totp.qr_code)
      setState('enroll-code')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    if (!factorId) {
      setError('No authenticator factor is ready. Start setup again.')
      setState('setup')
      return
    }

    setBusy(true)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (verifyError) throw verifyError

      if (state === 'enroll-code') {
        const { error: enrollAuditError } = await supabase.rpc('record_super_admin_mfa_event', {
          p_action: 'SUPER_ADMIN_MFA_ENROLLED',
        })
        if (enrollAuditError) throw enrollAuditError
      }
      const { error: verifyAuditError } = await supabase.rpc('record_super_admin_mfa_event', {
        p_action: 'SUPER_ADMIN_MFA_VERIFIED',
      })
      if (verifyAuditError) throw verifyAuditError

      setCode('')
      setState('ready')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'ready') return <>{children}</>

  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <section className="card space-y-4" aria-labelledby="admin-mfa-title">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">Super Admin Security</p>
          <h1 id="admin-mfa-title" className="mt-1 text-2xl font-bold text-navy">
            {state === 'loading' ? 'Checking authentication…' : 'Multi-factor authentication'}
          </h1>
        </div>

        {state === 'loading' ? (
          <p className="text-sm text-slate-600">Verifying your authenticator status.</p>
        ) : state === 'setup' ? (
          <>
            <p className="text-sm text-slate-600">
              Set up an authenticator app to secure this super-admin account. A 6-digit code will be
              required before admin data and actions are available.
            </p>
            <button className="btn-primary" onClick={() => void startEnrollment()} disabled={busy}>
              {busy ? 'Preparing…' : 'Set up authenticator'}
            </button>
          </>
        ) : (
          <>
            {state === 'enroll-code' && qrCode && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  Scan this code with an authenticator app, then enter the current 6-digit code.
                </p>
                <img className="h-48 w-48 border bg-white p-2" src={qrCode} alt="Authenticator setup QR code" />
              </div>
            )}
            {state === 'challenge' && (
              <p className="text-sm text-slate-600">Enter the current code from your authenticator app.</p>
            )}
            <form className="space-y-3" onSubmit={(event) => void verifyCode(event)}>
              <label className="block text-sm font-medium" htmlFor="admin-mfa-code">
                6-digit code
              </label>
              <input
                id="admin-mfa-code"
                className="input max-w-xs"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button className="btn-primary block" type="submit" disabled={busy || code.length !== 6}>
                {busy ? 'Verifying…' : 'Verify and continue'}
              </button>
            </form>
          </>
        )}

        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        <button className="btn-outline" onClick={() => void signOut()}>
          Sign out
        </button>
      </section>
    </div>
  )
}