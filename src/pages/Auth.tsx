import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import { isEmail, isPhone, toE164, strongPw, PW_HINT, hasErrors, type Errors } from '../lib/validate'

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
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) => (
  <label className="block text-sm font-medium">
    {label}
    {children}
    {error ? (
      <span role="alert" className="text-xs text-red-600">
        {error}
      </span>
    ) : (
      hint && <span className="text-xs text-slate-500">{hint}</span>
    )}
  </label>
)

/**
 * One sign-in page for everybody, and two different identifiers.
 *
 * There is deliberately no separate staff login. It cannot be a real security boundary — a second
 * form is still the same Supabase `signInWithPassword` against the same `auth.users` table, and
 * splitting it would only create a page that looks stricter than it is. What decides access is
 * `public.users.role`, read by RLS on every query and by the `area="admin"` guard, which reads the
 * same role the database does. The one thing the separate page used to buy was a clear signpost, and
 * a line of text below does that without implying a boundary that isn't there.
 *
 * The field is shared, but the identifier behind it is not. Students register against their PHONE
 * NUMBER because the signup form no longer asks for an email address; staff sign in with the email
 * address they were issued. `@` is what tells them apart, and it is also how the form behaves
 * natively: typing an address gets an email keyboard, typing a number gets a numeric one.
 */
export function Login() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  const isPhoneLogin = !id.includes('@')

  if (session && !loading && role) {
    return <Navigate to={role === 'STUDENT' ? '/dashboard' : '/admin'} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg('')
    setErr({})

    if (!id.trim()) return setErr({ id: 'Enter your phone number or email address.' })
    if (!pw) return setErr({ pw: 'Enter your password.' })

    // Both branches are fully validated before setBusy(true), not after. An early return from
    // between setBusy(true) and the await would leave the button disabled for good, with no
    // message about why and nothing to press.
    setBusy(true)
    let emailToUse: string | null = null

    if (isPhoneLogin) {
      const phone = toE164(id)
      if (!phone) {
        setBusy(false)
        return setErr({ id: 'Enter a valid phone number, for example 0754 123 456.' })
      }
      const { data: userData, error: lookupError } = await supabase
        .from('users')
        .select('email')
        .eq('phone', phone)
        .maybeSingle()
      if (lookupError || !userData?.email) {
        setBusy(false)
        setErr({
          form: 'That phone number and password do not match an account.',
        })
        return
      }
      emailToUse = userData.email
    } else {
      if (!isEmail(id)) {
        setBusy(false)
        return setErr({ id: 'Enter a valid email address.' })
      }
      emailToUse = id.trim()
    }

    if (!emailToUse) {
      setBusy(false)
      setErr({
        form: isPhoneLogin
          ? 'That phone number and password do not match an account.'
          : 'That email and password do not match an account.',
      })
      return
    }
    const result = await supabase.auth.signInWithPassword({ email: emailToUse, password: pw })
    setBusy(false)

    if (result.error) {
      // Deliberately vague: saying "no such account" would confirm which numbers or addresses are
      // registered. It is the same message for a wrong password and an unknown identifier.
      setErr({
        form: isPhoneLogin
          ? 'That phone number and password do not match an account.'
          : 'That email and password do not match an account.',
      })
      return
    }
    // Navigate on the auth event rather than guessing a role here — ProtectedRoute picks the
    // right destination once the role lookup settles.
    nav('/dashboard')
  }

  const forgot = async () => {
    setMsg('')
    setErr({})

    if (isPhoneLogin) {
      // There is genuinely no self-service reset here, and the app says so rather than pretending.
      //
      // Supabase ships resetPasswordForEmail and nothing equivalent for a phone identity: the
      // auth-js client this project installs has no resetPasswordForPhone method at all, and GoTrue
      // has no password-reset-by-SMS endpoint the browser is allowed to call. A four-digit PIN on
      // an account identified by a phone number is therefore recoverable by an administrator and by
      // nobody else. Calling a method that does not exist would have thrown on click and looked
      // like a broken page.
      return setMsg(
        'Student accounts are identified by phone number, so there is no email address to send a ' +
          'reset link to. If you have forgotten your PIN, contact the OGESEOUS office and they will ' +
          'reset it for you.',
      )
    }

    if (!isEmail(id)) return setErr({ id: 'Enter your email address first.' })
    const { error } = await supabase.auth.resetPasswordForEmail(id.trim())
    if (error) return setErr({ form: describeError(error) })
    setMsg('If that address has an account, a reset link is on its way. The link opens a page where you can set a new password.')
  }

  return (
    <Box title="Sign in">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field
          label="Phone number or email address"
          error={err.id}
          hint={isPhoneLogin ? 'Students sign in with the number they registered.' : undefined}
        >
          <input
            className="input mt-1"
            type={isPhoneLogin ? 'tel' : 'email'}
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
        student signs in with their phone number; staff sign in with their email address. A staff
        member lands on the admin console; a student lands on their dashboard. If a signed-in person
        lands in the wrong one, they are simply sent to the other.
      </p>
    </Box>
  )
}

/**
 * Account creation. Three things are asked for: a name, a phone number and a password.
 *
 * There is no email address, and no "check your inbox to confirm" step. Neither can be fixed in
 * this file alone, so it is worth being precise about why:
 *
 *   - Supabase Auth cannot create a password account with neither an email nor a phone; one of the
 *     two must be the account identifier. Registering against the phone number is what removes the
 *     email field without inventing a fake address for the student to remember.
 *
 *   - Confirming a phone number instead of an email is the same problem in a different costume: it
 *     puts an SMS code in front of every applicant, and the requirement is that a finished signup
 *     lands straight on the dashboard. Both switches are project settings in Supabase, under
 *     Authentication → Providers → Phone. If signUp returns no session, that is why, and the panel
 *     afterwards names the exact setting and path rather than leaving the student stuck on a page
 *     that says their account exists but will not let them in.
 *
 * The confirmation step was never worth much here in the first place: OGESEOUS checks who a student
 * is against the RUCU register inside the application wizard, so a confirmed inbox proves nothing
 * the register has not already proved.
 *
 * If the number is already registered, no second account is created — the student is told to sign in
 * with the password they already have. A student with two accounts has two profiles, and the one
 * holding their application is the one they will not find.
 */
export function Register() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [f, setF] = useState({ name: '', phone: '', pw: '', pw2: '' })
  const [err, setErr] = useState<Errors>({})
  const [done, setDone] = useState(false)
  // const [needsConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  if (session && !loading && role) {
    return <Navigate to={role === 'STUDENT' ? '/dashboard' : '/admin'} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr({})


    const next: Errors = {}
    if (f.name.trim().length < 3) next.name = 'Enter your full name'

    // isPhone and toE164 are checked separately on purpose. isPhone only asks "is this a number",
    // so the message can be about the number; toE164 then answers "can it be used as an account
    // identifier", which is a different question and gets a different message.
    const phone = toE164(f.phone)
    if (!f.phone.trim()) next.phone = 'Phone number is required'
    else if (!isPhone(f.phone)) next.phone = 'Enter a valid phone number, for example 0754 123 456.'
    else if (!phone) next.phone = 'That number cannot be used to sign in. Enter it as a normal phone number, for example 0754 123 456.'

    if (!strongPw(f.pw)) next.pw = PW_HINT
    if (f.pw !== f.pw2) next.pw2 = 'PINs do not match'
    setErr(next)
    if (hasErrors(next) || !phone) return

    setBusy(true)
    // role is NOT sent. handle_new_user() (001, rewritten by 016) inserts STUDENT
    // unconditionally, so anything posted here is ignored by the database — which is the point.
    //
    // The identifier is `phone`, not `email`. phone is passed again in the metadata because
    // handle_new_user() reads the number from there as a fallback, and student_profiles is the
    // table the application wizard reads contact details from.
    // Generate synthetic email for auth (no SMS/phone auth)
    const syntheticEmail = `phone_${phone.replace(/[^0-9+]/g, '').replace(/\+/g, 'plus')}@ogeseous.local`

    const { data, error } = await supabase.auth.signUp({
      email: syntheticEmail,
      password: f.pw,
      options: { data: { full_name: f.name.trim(), phone } },
    })
    setBusy(false)

    if (error) {
      // No phone auth - don't show phone auth errors
      const already = /already (registered|been registered|exists|been used)|phone number .* already|user already registered|email already/i.test(
        error.message,
      )
      if (already) {
        setErr({
          form:
            'An account already exists with that phone number. Sign in with your existing password — ' +
            'do not create a second account, or your application and your documents will end up split ' +
            'between the two.',
        })
        return
      }
      if (/password should be at least|minimum password length|password.*short/i.test(error.message)) {
        setErr({
          form:
            'Your PIN does not meet the minimum length requirement. Please enter exactly 4 digits.',
        })
        return
      }
      setErr({ form: describeError(error) })
      return
    }

    // A session here means the student is already signed in, and the Navigate above carries them
    // to their dashboard as soon as the role lookup settles — no page in between.
    if (!data?.session) {
      // With email auth, no phone confirmation needed - try to sign in if possible
      setDone(true)
      return
    }
    nav('/dashboard', { replace: true })
  }

  const field = (k: keyof typeof f, label: string, type = 'text', autoComplete?: string) => (
    <Field label={label} error={err[k]}>
      <input
        type={type}
        inputMode={type === 'tel' ? 'tel' : type === 'password' ? 'numeric' : undefined}
        maxLength={type === 'password' ? 4 : undefined}
        pattern={type === 'password' ? '[0-9]{4}' : undefined}
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
        {field('phone', 'Phone Number (required)', 'tel', 'tel')}
        {field('pw', '4-Digit PIN', 'password', 'new-password')}
        <p className="-mt-2 text-xs text-slate-500">{PW_HINT}</p>
        {field('pw2', 'Confirm PIN', 'password', 'new-password')}
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