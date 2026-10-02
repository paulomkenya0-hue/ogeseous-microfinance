import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { site } from '../config/site'
import { isEmail, isPhone } from '../lib/validate'

const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="mx-auto max-w-6xl px-4 py-12">
    <h2 className="mb-6 text-2xl font-bold text-navy">{title}</h2>
    {children}
  </section>
)

const FEATURES: [string, string][] = [
  ['Easy application', 'Register and apply online from your account.'],
  ['Secure and reliable', 'Accounts are protected with authenticated access, and verified details cannot be edited by the applicant.'],
  ['Student focused', 'Services designed around the needs of university students.'],
  ['Transparent process', 'Clear steps, a published repayment schedule, and an application you can check with its verification code.'],
]

const STEPS: [string, string, string][] = [
  ['01', 'Register', 'Create your student account with an email address and a password.'],
  ['02', 'Verify', 'Upload your Form Four certificate, identity document and passport photo. RUCU students are matched against the student register automatically.'],
  ['03', 'Apply', 'Enter the amount you need and the repayment period, then accept the Terms & Conditions and submit.'],
  ['04', 'Track', 'Follow your application and, once money is disbursed, your monthly repayment schedule and balance.'],
]

export function Home() {
  return (
    <>
      <section className="bg-gradient-to-br from-navy to-brand text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 md:grid-cols-2 md:py-24">
          <div>
            <h1 className="text-4xl font-extrabold leading-tight md:text-5xl">
              Student Loans for a Brighter Future
            </h1>
            <p className="mt-4 text-blue-100">
              OGESEOUS Microfinance provides student-focused financial support designed to help
              eligible university students pursue their education.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/register" className="btn-primary">
                Apply for a Loan
              </Link>
              <Link to="/how-it-works" className="btn border border-white/60 text-white hover:bg-white/10">
                How it works
              </Link>
            </div>
          </div>
          <div className="grid h-56 place-items-center rounded-2xl border-2 border-dashed border-white/40 text-sm text-blue-100 md:h-72">
            {/* TODO(OGESEOUS): replace with the official image and set site.logoUrl. */}
            Image placeholder
          </div>
        </div>
      </section>

      <div id="why">
        <Sec title="Why Choose OGESEOUS">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(([t, d]) => (
              <div className="card" key={t}>
                <h3 className="font-semibold text-navy">{t}</h3>
                <p className="mt-2 text-sm text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </Sec>
      </div>

      <Sec title="Supported Universities">
        <div className="grid gap-4 sm:grid-cols-3">
          {site.universities.map((u) => (
            <div className="card text-center" key={u.code}>
              <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full border-2 border-dashed border-slate-300 text-[10px] text-slate-400">
                LOGO
              </div>
              <p className="font-semibold text-navy">{u.name}</p>
              <p className="text-xs text-slate-500">{u.code}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-slate-600">
          Student eligibility is subject to verification and OGESEOUS Microfinance requirements.
          Submitting verification documents is not approval — a member of staff reviews every
          application.
        </p>
      </Sec>

      <Sec title="How It Works">
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([n, t, d]) => (
            <li className="card" key={n}>
              <span className="text-3xl font-extrabold text-accent">{n}</span>
              <h3 className="mt-1 font-semibold text-navy">{t}</h3>
              <p className="text-sm text-slate-600">{d}</p>
            </li>
          ))}
        </ol>
      </Sec>
    </>
  )
}

/**
 * Was `<Sec title="How It Works">…<Home /></Sec>`, which rendered the entire homepage — hero
 * banner and all — underneath its own heading.
 */
export function HowItWorks() {
  return (
    <Sec title="How It Works">
      <p className="mb-6 max-w-3xl text-slate-600">
        Four steps. Nothing here guarantees a loan — an application is always reviewed by a person,
        and a decision is recorded with a reason.
      </p>
      <ol className="grid gap-4 md:grid-cols-2">
        {STEPS.map(([n, t, d]) => (
          <li className="card" key={n}>
            <span className="text-2xl font-extrabold text-accent">{n}</span>
            <h3 className="mt-1 font-semibold text-navy">{t}</h3>
            <p className="text-sm text-slate-600">{d}</p>
          </li>
        ))}
      </ol>

      <div className="card mt-6">
        <h3 className="font-semibold text-navy">After your loan is disbursed</h3>
        <p className="mt-2 text-sm text-slate-600">
          Your loan is divided into monthly installments from the agreed term, each with its own due
          date. Sign in to see the schedule, what you have paid and what is still outstanding.
          Payments are applied to the oldest unpaid installment first. If you fall behind, contact
          OGESEOUS before a payment is missed — the arrears page on your dashboard shows exactly
          where you stand.
        </p>
      </div>
    </Sec>
  )
}

/**
 * Renders an empty contact field as an explicit gap rather than as a plausible-looking blank.
 * These are still unset, and the site should say so rather than imply an address exists.
 */
const Info = () => {
  const rows: [string, string][] = [
    ['Phone', site.contact.phone],
    ['Email', site.contact.email],
    ['Address', site.contact.address],
    ['Working hours', site.contact.hours],
  ]
  const missing = rows.filter(([, v]) => !v)

  return (
    <div className="mt-2">
      <dl className="grid gap-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="inline font-medium">{k}: </dt>
            <dd className="inline text-slate-600">{v || <span className="italic text-amber-700">not yet published</span>}</dd>
          </div>
        ))}
      </dl>
      {missing.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          OGESEOUS Microfinance has not yet published these details. Fill them in before
          advertising this service — a contact form that cannot reach anyone is worse than no
          contact form at all.
        </p>
      )}
    </div>
  )
}

export function About() {
  const points: [string, string][] = [
    ['Our purpose', 'To provide student-focused financial support for eligible university students.'],
    [
      'Who we serve',
      'Students of Ruaha Catholic University, Mkwawa University College and Iringa University, subject to verification.',
    ],
    ['Our process', 'Register, verify, apply, and track your application and repayment schedule from your account.'],
    [
      'How we check identity',
      'RUCU students are matched against the university student register. Students at the other supported universities are checked by staff against the documents they upload.',
    ],
    [
      'What we never do',
      'We never allow a student to edit a verified name, university or registration number after approval, and we never approve an application automatically.',
    ],
  ]

  return (
    <Sec title="About OGESEOUS Microfinance">
      <div className="space-y-4">
        {points.map(([t, d]) => (
          <div className="card" key={t}>
            <h3 className="font-semibold text-navy">{t}</h3>
            <p className="mt-1 text-slate-600">{d}</p>
          </div>
        ))}
        <div className="card">
          <h3 className="font-semibold text-navy">Contact information</h3>
          <Info />
        </div>
      </div>
    </Sec>
  )
}

export function Contact() {
  const [f, setF] = useState({ name: '', email: '', phone: '', subject: '', message: '' })
  const [err, setErr] = useState<Record<string, string>>({})
  const [sent, setSent] = useState(false)

  /**
   * Opens the visitor's own mail client with the message pre-filled.
   *
   * The previous version validated the fields and then reported that sending was not configured.
   * That is honest but leaves a dead end; with a published address in site.contact, a mailto link
   * actually delivers the enquiry. Nothing is invented — if no address is configured, the honest
   * notice is shown instead of a link to nowhere.
   */
  const canSend = Boolean(site.contact.email)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (f.name.trim().length < 2) next.name = 'Enter your full name'
    if (!isEmail(f.email)) next.email = 'Enter a valid email address'
    if (f.phone && !isPhone(f.phone)) next.phone = 'Enter a valid phone number'
    if (f.subject.trim().length < 3) next.subject = 'Enter a subject'
    if (f.message.trim().length < 10) next.message = 'Message must be at least 10 characters'
    setErr(next)
    if (Object.keys(next).length > 0) return

    if (!canSend) {
      setSent(true)
      return
    }

    const body = [
      `Name: ${f.name.trim()}`,
      `Email: ${f.email.trim()}`,
      f.phone.trim() ? `Phone: ${f.phone.trim()}` : '',
      '',
      f.message.trim(),
    ]
      .filter(Boolean)
      .join('\n')

    window.location.href = `mailto:${site.contact.email}?subject=${encodeURIComponent(
      `[OGESEOUS website] ${f.subject.trim()}`,
    )}&body=${encodeURIComponent(body)}`
    setSent(true)
  }

  const field = (k: keyof typeof f, label: string, area = false) => (
    <label className="block text-sm font-medium">
      {label}
      {area ? (
        <textarea
          rows={5}
          className="input mt-1"
          value={f[k]}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        />
      ) : (
        <input
          className="input mt-1"
          value={f[k]}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        />
      )}
      {err[k] && (
        <span role="alert" className="text-xs text-red-600">
          {err[k]}
        </span>
      )}
    </label>
  )

  return (
    <Sec title="Contact Us">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="card">
          <h3 className="font-semibold text-navy">Our details</h3>
          <Info />
        </div>
        <form onSubmit={submit} className="card space-y-3" noValidate>
          {field('name', 'Full Name')}
          {field('email', 'Email')}
          {field('phone', 'Phone')}
          {field('subject', 'Subject')}
          {field('message', 'Message', true)}
          <button className="btn-blue w-full">{canSend ? 'Send message' : 'Check message'}</button>
          {sent && (
            <p
              role="status"
              className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800"
            >
              {canSend
                ? 'Your mail application should now be open with the message filled in. It only reaches OGESEOUS if you press send there.'
                : 'Your details are valid, but OGESEOUS has not published an email address yet, so there is nowhere for this message to go. No message was delivered.'}
            </p>
          )}
        </form>
      </div>
    </Sec>
  )
}

/**
 * NOT a legal document, and it does not pretend to be one.
 *
 * Writing a privacy policy or terms of business from a codebase would be inventing legal text, so
 * this page states plainly that the official wording is still required, and lists what the system
 * demonstrably does — every line below corresponds to code, not to a policy intention. That gives
 * OGESEOUS a starting draft to have reviewed rather than an empty page, and nothing misleading in
 * the meantime.
 */
export function Legal({ title }: { title: string }) {
  const isPrivacy = title.toLowerCase().includes('privacy')

  const facts: [string, string][] = isPrivacy
    ? [
        ['What is collected', 'Your email address and password hash (held by Supabase Auth, not by this application), your name and phone number, and the three verification documents you upload.'],
        ['Who can read your documents', 'Only OGESEOUS staff. Other students cannot, and neither can the public. The documents are stored in a private storage bucket.'],
        ['What is public', 'Only what you explicitly look up with the application number and verification code on the /verify page: the application number, your name, your university, the status and the submission date. Nothing else is public.'],
        ['What staff can change', 'Your verified name, university, registration number and Form Four index number. You cannot change these yourself — that is deliberate, so that what appears on your application is what was verified.'],
        ['How long records are kept', 'Loan records are retained as the institution\'s financial records. Verification documents can be deleted by you before submission.'],
        ['Deleting your account', 'You can request deletion from your dashboard while no loan is on record. If a loan exists, the account cannot be deleted, because that would delete the institution\'s record of the debt — the loan must be settled or written off first.'],
        ['Every staff action is logged', 'Approvals, rejections, disbursements, repayments, reversals, role changes and account suspensions are written to an audit log with the acting staff member and the time.'],
      ]
    : [
        ['Who may apply', 'Students of Ruaha Catholic University, Mkwawa University College or Iringa University, whose identity has been verified.'],
        ['Approval is not automatic', 'Every application is reviewed by staff. Verification confirms you are a student; it does not entitle you to a loan.'],
        ['Amount and term', 'The permitted amount and the repayment periods are set by OGESEOUS and displayed on the application form before you submit.'],
        ['Repayment', 'Your loan is divided into monthly installments from the agreed term, each with its own due date. Payments are applied to the oldest unpaid installment first.'],
        ['Interest', 'Whether interest is charged, at what rate and on which convention, is stated to you before you submit. If no rate is shown on your application, none is being charged.'],
        ['If you fall behind', 'Contact OGESEOUS. A missed installment does not by itself cancel the loan, and agreeing a way forward is better than letting it sit.'],
        ['Corrections', 'A mistaken payment is reversed by a manager with a stated reason; the original entry is kept and shown as reversed. It is never deleted.'],
      ]

  return (
    <Sec title={title}>
      <div className="card border-amber-200 bg-amber-50">
        <p className="text-sm text-amber-900">
          <b>This is a draft summary, not the official document.</b> The {title.toLowerCase()} must be
          written and approved by OGESEOUS Microfinance, and — in Tanzania — reviewed against the
          applicable data protection and financial regulations. What follows describes what this
          system actually does, so that OGESEOUS has something concrete to review. It has no legal
          standing and should not be relied on.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {facts.map(([t, d]) => (
          <div className="card" key={t}>
            <h3 className="font-semibold text-navy">{t}</h3>
            <p className="mt-1 text-sm text-slate-600">{d}</p>
          </div>
        ))}
      </div>

      <p className="mt-6 text-sm text-slate-600">
        <Link className="text-brand underline" to="/contact">
          Contact OGESEOUS
        </Link>{' '}
        with any question about your account or your data.
      </p>
    </Sec>
  )
}