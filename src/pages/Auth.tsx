import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import { isEmail, isPhone, strongPw, PW_HINT, hasErrors, type Errors } from '../lib/validate'

const Box = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mx-auto max-w-md px-4 py-12">
    <div className="card">
      <h1 className="mb-4 text-2xl font-bold text-navy">{title}</h1>
      {!configured && (
        <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          Database not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.
        </p>
      )}
      {children}
    </div>
  </div>
)

const Field = ({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) => (
  <label className="block text-sm font-medium">
    {label}
    {children}
    {error && (
      <span role="alert" className="text-xs text-red-600">
        {error}
      </span>
    )}
  </label>
)

/**
 * One sign-in page for everybody.
 *
 * There is deliberately no separate staff login. It cannot be a real security boundary — a second
 * form is still the same Supabase `signInWithPassword` against the same `auth.users` table, and
 * splitting it would only create a page that looks stricter than it is. What decides access is
 * `public.users.role`, read by RLS on every query and by the `area="admin"` guard, which reads the
 * same role the database does. The one thing the separate page used to buy was a clear signpost, and
 * a line of text below does that without implying a boundary that isn't there.
 */
export function Login() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  if (session && !loading && role) {
    return <Navigate to={role === 'STUDENT' ? '/dashboard' : '/admin'} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')
    setErr({})

    if (!id.includes('@')) {
      return setErr({
        id: 'Sign in with the email address you registered with.',
      })
    }
    if (!isEmail(id) || !pw) {
      return setErr({ ...(!isEmail(id) ? { id: 'Enter a valid email address' } : {}), ...(!pw ? { pw: 'Enter your password' } : {}) })
    }

    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email: id.trim(), password: pw })
    setBusy(false)

    if (error) {
      // Deliberately vague: saying "no such email" would confirm which addresses have accounts.
      setErr({ form: 'That email and password do not match an account.' })
      return
    }
    // Navigate on the auth event rather than guessing a role here — ProtectedRoute picks the
    // right destination once the role lookup settles.
    nav('/dashboard')
  }

  const forgot = async () => {
    setMsg('')
    setErr({})
    if (!isEmail(id)) return setErr({ id: 'Enter your email address first.' })
    const { error } = await supabase.auth.resetPasswordForEmail(id.trim())
    if (error) return setErr({ form: describeError(error) })
    setMsg('If that address has an account, a reset link is on its way. The link opens a page where you can set a new password.')
  }

  return (
    <Box title="Sign in">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field label="Email address" error={err.id}>
          <input
            className="input mt-1"
            type="email"
            value={id}
            onChange={(e) => setId(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field label="Password" error={err.pw}>
          <input
            type="password"
            className="input mt-1"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {err.form && (
          <p role="alert" className="text-sm text-red-600">
            {err.form}
          </p>
        )}
        {msg && (
          <p role="status" className="text-sm text-slate-700">
            {msg}
          </p>
        )}
        <button className="btn-blue w-full" disabled={busy || !configured}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="mt-4 flex justify-between text-sm">
        <button type="button" className="text-brand underline" onClick={() => void forgot()} disabled={!configured}>
          Forgot password
        </button>
        <Link className="text-brand underline" to="/register">
          Create account
        </Link>
      </div>

      <p className="mt-4 border-t pt-3 text-xs text-slate-500">
        Students and OGESEOUS staff sign in here with the same form and go to different places. A
        staff member lands on the admin console; a student lands on their dashboard. If a signed-in
        person lands in the wrong one, they are simply sent to the other.
      </p>
    </Box>
  )
}

/**
 * Account creation.
 *
 * There is no "check your email to confirm the address" step, and there never should be in this
 * flow: OGESEOUS verifies a student against the RUCU register inside the application wizard, so an
 * unconfirmed email address proves nothing that the register has not already proved, while adding a
 * step most students cannot complete because the office has no way to resend a confirmation for an
 * address the student mistyped.
 *
 * Email confirmation is a Supabase *project setting*, not something this code can switch off. When
 * signUp returns no session it means the setting is still on, and saying so — by name, with the
 * path to it — is the difference between a student who knows what to tell the office and a support
 * ticket that starts with "it says my account was created but I cannot log in".
 *
 * If the address is already registered, signInWithPassword is tried rather than a second account
 * being created: a student with two accounts has two profiles, and the one holding their
 * application is the one they will not find.
 */
export function Register() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [f, setF] = useState({ name: '', email: '', phone: '', pw: '', pw2: '' })
  const [err, setErr] = useState<Errors>({})
  const [done, setDone] = useState(false)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  if (session && !loading && role) {
    return <Navigate to={role === 'STUDENT' ? '/dashboard' : '/admin'} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr({})
    setNeedsConfirm(false)

    const next: Errors = {}
    if (f.name.trim().length < 3) next.name = 'Enter your full name'
    if (!isEmail(f.email)) next.email = 'Enter a valid email address'
    if (!isPhone(f.phone)) next.phone = 'Enter a valid phone number'
    if (!strongPw(f.pw)) next.pw = PW_HINT
    if (f.pw !== f.pw2) next.pw2 = 'Passwords do not match'
    setErr(next)
    if (hasErrors(next)) return

    setBusy(true)
    // role is NOT sent. handle_new_user() in 001 inserts STUDENT unconditionally, so anything
    // posted here is ignored by the database — which is the point.
    const { data, error } = await supabase.auth.signUp({
      email: f.email.trim(),
      password: f.pw,
      options: { data: { full_name: f.name.trim(), phone: f.phone.trim() } },
    })
    setBusy(false)

    if (error) {
      const already = /already (registered|been registered|exists|been used)/i.test(error.message)
      if (already) {
        setErr({
          form:
            'An account already exists with that email address. Sign in with your existing password — ' +
            'do not create a second account, or your application and your documents will end up split ' +
            'between the two.',
        })
        return
      }
      setErr({ form: describeError(error) })
      return
    }

    // No session means the project still demands email confirmation. The account exists; the app
    // just cannot hold it signed in yet.
    setNeedsConfirm(!data?.session)
    setDone(true)
  }

  const field = (k: keyof typeof f, label: string, type = 'text', autoComplete?: string) => (
    <Field label={label} error={err[k]}>
      <input
        type={type}
        className="input mt-1"
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        autoComplete={autoComplete}
      />
    </Field>
  )

  if (done) {
    return (
      <Box title="Account created">
        <p role="status" className="text-sm text-slate-700">
          Account created successfully.
        </p>

        {needsConfirm && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">One setting is still switched on</p>
            <p className="mt-1">
              Your account exists and your password works. OGESEOUS has not yet turned off email
              confirmation for this project, so the app cannot sign you in automatically.
            </p>
            <p className="mt-2">
              A manager can switch it off in Supabase under{' '}
              <b>Authentication → Providers → Email</b>, by unticking <b>Confirm email</b>. Until then
              use <b>Forgot password</b> on the sign-in page to set a password and confirm the address
              in one step.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn-primary flex-1" onClick={() => nav('/dashboard', { replace: true })}>
            [ Go to Dashboard ]
          </button>
          <Link className="btn-outline" to="/login">
            Sign in
          </Link>
        </div>
      </Box>
    )
  }

  return (
    <Box title="Create Student Account">
      <p className="mb-4 text-sm text-slate-600">
        You need one account only. If you have applied before, sign in instead of creating another.
      </p>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {field('name', 'Full Name', 'text', 'name')}
        {field('email', 'Email', 'email', 'email')}
        {field('phone', 'Phone Number', 'tel', 'tel')}
        {field('pw', 'Password', 'password', 'new-password')}
        <p className="-mt-2 text-xs text-slate-500">{PW_HINT}</p>
        {field('pw2', 'Confirm Password', 'password', 'new-password')}
        {err.form && (
          <p role="alert" className="text-sm text-red-600">
            {err.form}
          </p>
        )}
        <button className="btn-primary w-full" disabled={busy || !configured}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm">
        Already registered?{' '}
        <Link className="text-brand underline" to="/login">
          Sign in
        </Link>
      </p>
    </Box>
  )
}