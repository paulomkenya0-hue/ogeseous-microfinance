import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import type { AuthError } from '@supabase/supabase-js'
import { supabase, configured } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import {
  isEmail,
  isPhone,
  toE164,
  strongPw,
  pinToAuthPassword,
  phoneToAuthEmail,
  PW_HINT,
  hasErrors,
  type Errors,
} from '../lib/validate'

type SignInCredentials = { email: string; password: string } | { phone: string; password: string }

/**
 * The errors after which another sign-in attempt is worth making: a wrong credential (so the next
 * stored form of it may fit), or the phone-identity path on a project that does not run the Phone
 * provider. Anything else — a rate limit, a network failure — is shown to the user as-is.
 */
const isRetryableSignInError = (error: AuthError): boolean =>
  error.code === 'invalid_credentials' ||
  error.code === 'phone_provider_disabled' ||
  /invalid login credentials/i.test(error.message) ||
  /phone logins? (are )?(not enabled|disabled)|unsupported phone provider/i.test(error.message)

const isUnconfirmedAccount = (error: AuthError): boolean =>
  error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message)

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
    if (!isPhoneLogin) {
      if (!isEmail(id)) return setErr({ id: 'Enter a valid email address.' })

      // Staff sign in with the password exactly as it was set — no stretching. Their accounts are
      // ordinary email identities, created and reset through Supabase's own flows.
      setBusy(true)
      try {
        const { error } = await supabase.auth.signInWithPassword({ email: id.trim(), password: pw })
        if (error) {
          if (isUnconfirmedAccount(error)) {
            return setErr({
              form: 'This account has not been confirmed yet. Please contact the OGESEOUS office.',
            })
          }
          // Keep credential failures indistinguishable, but show operational errors such as rate
          // limits and network failures so staff know the login service, not their password, failed.
          return setErr({
            form: isRetryableSignInError(error)
              ? 'That email and password do not match an account.'
              : describeError(error),
          })
        }
        nav('/admin')
      } catch (e) {
        setErr({ form: describeError(e) })
      } finally {
        setBusy(false)
      }
      return
    }

    const phone = toE164(id)
    if (!phone) return setErr({ id: 'Enter a valid phone number, for example 0754 123 456.' })

    // The account's auth email is derived from the phone number, exactly as registration derived
    // it — no lookup in public.users, whose RLS policy rightly refuses an anonymous caller. (That
    // lookup ran here before, returned nothing under the policy, and made every student sign-in
    // fail with "do not match an account" no matter how correct the PIN was.)
    //
    // Order of attempts: the stretched PIN first, because that is every account created now; then
    // the raw PIN, for accounts created while the server's minimum password length had been
    // lowered by hand or reset to a bare PIN by an administrator; then the same two against the
    // phone identity, for any account from the short-lived 016 phone-auth flow. A wrong PIN walks
    // all four and lands on the same vague message as an unknown number.
    const email = phoneToAuthEmail(phone)
    const stretched = pinToAuthPassword(pw)
    const attempts: SignInCredentials[] = [
      { email, password: stretched },
      { email, password: pw },
      { phone, password: stretched },
      { phone, password: pw },
    ]

    setBusy(true)
    let signedIn = false
    let failure: string | null = null
    try {
      for (const credentials of attempts) {
        const { error } = await supabase.auth.signInWithPassword(credentials)
        if (!error) {
          signedIn = true
          break
        }
        if (isUnconfirmedAccount(error)) {
          failure =
            'Your account exists but has not been confirmed yet. Please contact the OGESEOUS office.'
          break
        }
        if (!isRetryableSignInError(error)) {
          failure = describeError(error)
          break
        }
      }
    } catch (e) {
      failure = describeError(e)
    } finally {
      setBusy(false)
    }

    if (signedIn) {
      // Navigate on the auth event rather than guessing a role here — ProtectedRoute picks the
      // right destination once the role lookup settles.
      nav('/dashboard')
      return
    }
    // Deliberately vague, as above: wrong PIN and unknown number are indistinguishable.
    setErr({ form: failure ?? 'That phone number and password do not match an account.' })
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
 * There is no email address, and no "check your inbox to confirm" step. Two design facts sit
 * behind that, and both live outside this form:
 *
 *   - Supabase Auth cannot create a password account with neither an email nor a phone, and this
 *     project runs no SMS provider, so the account is created against a synthetic address derived
 *     from the phone number (phoneToAuthEmail). The student never sees it; sign-in derives the
 *     same address from the number they type.
 *
 *   - The four-digit PIN is never sent to the auth server bare. GoTrue enforces its own minimum
 *     password length — six by default — before any code in this repository runs, and the
 *     rejection used to surface here as "your PIN does not meet the minimum length requirement"
 *     on a perfectly valid PIN. pinToAuthPassword stretches it deterministically, and sign-in
 *     applies the same stretching, so registration works whatever the server's minimum is.
 *
 * The confirmation step was never worth much here in the first place: OGESEOUS checks who a student
 * is against the RUCU register inside the application wizard, so a confirmed inbox proves nothing
 * the register has not already proved. If the project's "Confirm email" switch is on, signUp
 * returns no session, and the panel afterwards tells the student to sign in — and, if the account
 * still needs confirming, to contact the office — rather than leaving them on a page that says
 * their account exists but will not let them in.
 *
 * If the number is already registered, no second account is created — the student is told to sign in
 * with the password they already have. A student with two accounts has two profiles, and the one
 * holding their application is the one they will not find.
 */
export function Register() {
  const { session, role, loading } = useAuth()
  const nav = useNavigate()
  const [f, setF] = useState({ phone: '', pw: '', pw2: '' })
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
    // role is NOT sent. handle_new_user() (001, rewritten by 016/018) inserts STUDENT
    // unconditionally, so anything posted here is ignored by the database — which is the point.
    //
    // The auth identifier is a synthetic email derived from the phone number — the project runs no
    // SMS provider, so Supabase's phone identity is not used — and the PIN is stretched before it
    // is sent, because GoTrue enforces its own minimum password length server-side and would
    // reject the bare four digits no matter what this form accepted. phone is passed again in the
    // metadata because handle_new_user() reads the number from there as a fallback, and
    // student_profiles is the table the application wizard reads contact details from.
    const { data, error } = await supabase.auth.signUp({
      email: phoneToAuthEmail(phone),
      password: pinToAuthPassword(f.pw),
      options: { data: { phone } },
    })
    setBusy(false)

    if (error) {
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
      setErr({ form: describeError(error) })
      return
    }

    // A session here means the student is already signed in, and the Navigate above carries them
    // to their dashboard as soon as the role lookup settles — no page in between.
    if (!data?.session) {
      // The account exists but no session came back — the project's "Confirm email" switch is on.
      // There is no inbox to confirm through (the address is synthetic), so the panel sends the
      // student to sign in, where an unconfirmed account gets a message that says what to do.
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
          Your account has been created. Sign in with your phone number and your 4-digit PIN. If
          sign-in says the account is not confirmed yet, ask the OGESEOUS office to confirm it.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn-primary flex-1" onClick={() => nav('/login', { replace: true })}>
            [ Sign in ]
          </button>
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