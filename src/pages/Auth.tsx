import { useState, FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'; import { useAuth } from '../auth/AuthContext'; import { isEmail, isPhone, strongPw } from '../lib/validate'
const Box = ({ title, children }: { title: string; children: React.ReactNode }) => <div className="mx-auto max-w-md px-4 py-12"><div className="card"><h1 className="mb-4 text-2xl font-bold text-navy">{title}</h1>
  {!configured && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Database not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.</p>}{children}</div></div>
export function Login() {
  const { session, role } = useAuth(); const nav = useNavigate(); const [id, setId] = useState(''); const [pw, setPw] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  if (session && role) return <Navigate to={role === 'STUDENT' ? '/student/dashboard' : '/admin'} replace />
  const submit = async (e: FormEvent) => { e.preventDefault(); setMsg('')
    if (!id.includes('@')) return setMsg('Login with registration number becomes available after student verification. Please use your email.')
    if (!isEmail(id) || !pw) return setMsg('Enter a valid email and your password.')
    setBusy(true); const { error } = await supabase.auth.signInWithPassword({ email: id.trim(), password: pw }); setBusy(false)
    if (error) setMsg('Invalid email or password.'); else nav('/student/dashboard') }
  const forgot = async () => { if (!isEmail(id)) return setMsg('Enter your email first.'); const { error } = await supabase.auth.resetPasswordForEmail(id.trim()); setMsg(error ? 'Could not send reset email.' : 'If the account exists, a reset email has been sent.') }
  return <Box title="Student Login"><form onSubmit={submit} className="space-y-3" noValidate>
    <label className="block text-sm font-medium">Email or Registration Number<input className="input mt-1" value={id} onChange={e => setId(e.target.value)} autoComplete="username" /></label>
    <label className="block text-sm font-medium">Password<input type="password" className="input mt-1" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" /></label>
    {msg && <p role="alert" className="text-sm text-red-600">{msg}</p>}
    <button className="btn-blue w-full" disabled={busy || !configured}>{busy ? 'Signing in…' : 'Login'}</button></form>
    <div className="mt-4 flex justify-between text-sm"><button className="text-brand underline" onClick={forgot} disabled={!configured}>Forgot Password</button><Link className="text-brand underline" to="/register">Create Account</Link></div></Box>
}
export function Register() {
  const [f, setF] = useState({ name: '', email: '', phone: '', pw: '', pw2: '' }); const [err, setErr] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => { e.preventDefault(); const x: Record<string, string> = {}
    if (f.name.trim().length < 3) x.name = 'Enter your full name'; if (!isEmail(f.email)) x.email = 'Enter a valid email'; if (!isPhone(f.phone)) x.phone = 'Enter a valid phone number'
    if (!strongPw(f.pw)) x.pw = 'Min 8 characters with letters and a number'; if (f.pw !== f.pw2) x.pw2 = 'Passwords do not match'
    setErr(x); if (Object.keys(x).length) return
    setBusy(true) // role is NOT sent; database trigger forces STUDENT
    const { error } = await supabase.auth.signUp({ email: f.email.trim(), password: f.pw, options: { data: { full_name: f.name.trim(), phone: f.phone.trim() } } }); setBusy(false)
    setMsg(error ? 'Could not create account. ' + error.message : 'Account created. Check your email to confirm (if required), then log in.') }
  const fld = (k: keyof typeof f, label: string, type = 'text') => <label className="block text-sm font-medium">{label}<input type={type} className="input mt-1" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />{err[k] && <span role="alert" className="text-xs text-red-600">{err[k]}</span>}</label>
  return <Box title="Create Student Account"><form onSubmit={submit} className="space-y-3" noValidate>{fld('name', 'Full Name')}{fld('email', 'Email', 'email')}{fld('phone', 'Phone Number', 'tel')}{fld('pw', 'Password', 'password')}{fld('pw2', 'Confirm Password', 'password')}
    {msg && <p role="status" className="text-sm text-slate-700">{msg}</p>}<button className="btn-primary w-full" disabled={busy || !configured}>{busy ? 'Creating…' : 'Create Account'}</button></form>
    <p className="mt-4 text-sm">Already registered? <Link className="text-brand underline" to="/login">Login</Link></p></Box>
}
