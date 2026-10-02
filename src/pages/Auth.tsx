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

export function Login() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  if (session && !loading && role) {
    return <Navigate to={role === 'STUDENT' ? '/student/dashboard' : '/admin'} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')
    setErr({})

    if (!id.includes('@')) {
      return setErr({
        id: 'Login with your registration number becomes available after student verification. For now, use your email.',
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
    nav('/student/dashboard')
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
    <Box title="Student Login">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field label="Email or Registration Number" error={err.id}>
          <input
            className="input mt-1"
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
          {busy ? 'Signing in…' : 'Login'}
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
    </Box>
  )
}

export function Register() {
  const [f, setF] = useState({ name: '', email: '', phone: '', pw: '', pw2: '' })
  const [err, setErr] = useState<Errors>({})
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')

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
    const { error } = await supabase.auth.signUp({
      email: f.email.trim(),
      password: f.pw,
      options: { data: { full_name: f.name.trim(), phone: f.phone.trim() } },
    })
    setBusy(false)

    if (error) {
      setErr({ form: describeError(error) })
      return
    }
    setMsg(
      'Account created. Check your email to confirm the address, then sign in. If your university is Mkwawa or Iringa, start student verification next.',
    )
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

  return (
    <Box title="Create Student Account">
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
        {msg && (
          <p role="status" className="text-sm text-slate-700">
            {msg}
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
