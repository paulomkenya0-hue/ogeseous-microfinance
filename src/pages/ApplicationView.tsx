import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc, tzs } from '../lib/api'
import { Badge, Card, ErrorNote, Money, Row, STATUS_TONE, dateTime } from '../components/ui'
import { universityName, site } from '../config/site'
import { openDocument } from '../lib/storage'
import { APP_DOC_LABELS, STATUS_EXPLAIN, STATUS_LABEL, monthLabel, purposeText, type AppDocType } from '../lib/application'

type App = {
  id: string
  application_number: string | null
  verification_token: string | null
  amount: number | null
  purpose: string | null
  purpose_other: string | null
  repayment_period_months: number | null
  status: string
  submitted_at: string | null
  updated_at: string
  review_notes: string | null
  action_required_note: string | null
  monthly_income: number | null
  income_source: string | null
  monthly_expenses: number | null
  has_financial_support: boolean | null
  support_amount: number | null
  support_source: string | null
  guarantor_full_name: string | null
  guarantor_relationship: string | null
  guarantor_phone: string | null
  guarantor_national_id: string | null
  guarantor_address: string | null
  programme: string | null
  year_of_study: string | null
  verification_method: string | null
}
type Profile = {
  full_name: string
  university: string | null
  registration_number: string | null
  phone: string | null
  address: string | null
}
type DocRow = { doc_type: string; storage_path: string; uploaded_at: string }
type HistoryRow = {
  from_status: string | null
  to_status: string
  note: string | null
  actor_name: string | null
  actor_role: string | null
  created_at: string
}

/**
 * The student's view of one application: what it says, where it is, what has happened to it, and
 * what they uploaded.
 *
 * "Last updated" comes from the application row's own updated_at and "what happened" from
 * application_status_history, which a security-definer function writes. Neither is reconstructed in
 * the browser from what it happens to know, because a page that guesses at a status is exactly the
 * page that tells a student their loan was approved when it was not.
 */
export default function ApplicationView() {
  const { session } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [docs, setDocs] = useState<DocRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [qr, setQr] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pdfError, setPdfError] = useState('')
  const [docBusy, setDocBusy] = useState('')
  const [resubmitting, setResubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const uid = session.user.id
      const [a, p] = await Promise.all([
        supabase
          .from('loan_applications')
          .select('*')
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(1),
        supabase
          .from('student_profiles')
          .select('full_name,university,registration_number,phone,address')
          .eq('user_id', uid)
          .single(),
      ])
      if (a.error) throw new Error(a.error.message)
      if (p.error) throw new Error(p.error.message)
      const row = ((a.data ?? []) as App[])[0] ?? null
      setApp(row)
      setProfile(p.data as Profile)

      if (row) {
        const [d, h] = await Promise.all([
          supabase
            .from('loan_documents')
            .select('doc_type,storage_path,uploaded_at')
            .eq('application_id', row.id),
          // No .catch(() => []) here.
          //
          // That fallback returned an empty array on failure, which is indistinguishable from an
          // application that genuinely has no history — so a permission refusal, an expired session
          // and a missing RPC all rendered as a blank timeline with no message at all. It is the
          // same bug that made the RUCU lookup report "student not found" for every kind of
          // failure. Letting it throw means the real message is shown instead.
          //
          // The application still renders: setApp() has already run above, so the catch falls
          // through to the inline ErrorNote with a retry button rather than to the full-page
          // failure, which is reserved for "no application at all".
          rpc<HistoryRow>('get_application_history', { p_id: row.id }),
        ])
        if (d.error) throw new Error(d.error.message)
        setDocs((d.data ?? []) as DocRow[])
        setHistory(h)
      } else {
        setDocs([])
        setHistory([])
      }
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!app?.application_number || !app.verification_token) return
    let active = true

    /**
     * BASE_URL, not window.location.origin.
     *
     * The app is deployed under a sub-path on GitHub Pages (/ogeseous-microfinance/), so an
     * origin-rooted link produced a QR code that resolved to a 404 for anyone who scanned it.
     */
    const url = `${window.location.origin}${import.meta.env.BASE_URL}verify?app=${encodeURIComponent(
      app.application_number,
    )}&token=${encodeURIComponent(app.verification_token)}`

    QRCode.toDataURL(url, { margin: 1, width: 220 })
      .then((data) => active && setQr(data))
      .catch(() => active && setQr(''))

    return () => {
      active = false
    }
  }, [app])

  const viewDoc = async (d: DocRow) => {
    setDocBusy(d.doc_type)
    try {
      await openDocument(d.storage_path)
      setDocBusy('')
    } catch (e) {
      setDocBusy('')
      setPdfError(describeError(e))
    }
  }

  const resubmit = async () => {
    if (!app) return
    setResubmitting(true)
    const { error: e } = await supabase.rpc('resubmit_application', { p_id: app.id })
    setResubmitting(false)
    if (e) return setError(describeError(e))
    await load()
  }

  const download = async () => {
    if (!app || !profile) return
    setBusy(true)
    setPdfError('')
    try {
      // Loaded on demand. jsPDF drags in html2canvas and DOMPurify — about 350KB — and importing
      // it at module scope put that cost on every page of the app, for students who never open
      // this one.
      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF()

      const NAVY: [number, number, number] = [11, 42, 91]
      doc.setFontSize(16)
      doc.setTextColor(...NAVY)
      doc.text(site.name, 14, 18)
      doc.setFontSize(10)
      doc.setTextColor(90)
      doc.text(site.tagline, 14, 24)
      doc.setDrawColor(220)
      doc.line(14, 28, 196, 28)
      doc.setFontSize(13)
      doc.setTextColor(20)
      doc.text('Student Loan Application', 14, 38)

      let y = 50
      const heading = (t: string) => {
        doc.setFontSize(11)
        doc.setTextColor(...NAVY)
        doc.text(t, 14, y)
        y += 8
      }
      const row = (label: string, value: string | null | undefined) => {
        doc.setFontSize(10)
        doc.setTextColor(100)
        doc.text(label, 14, y)
        doc.setTextColor(20)
        // doc.text throws on characters outside the Latin-1 range jsPDF's core fonts support.
        doc.text((value || '—').replace(/[^\x20-\x7E]/g, '?'), 70, y)
        y += 8
      }

      heading('1. Student details')
      row('Application no.', app.application_number ?? 'Not submitted')
      row('Full name', profile.full_name)
      row('University', universityName(profile.university))
      row('Registration no.', profile.registration_number)
      row('Programme', app.programme)
      row('Year of study', app.year_of_study)

      y += 4
      heading('2. Loan details')
      row('Amount requested', tzs(app.amount))
      row('Purpose', purposeText(app.purpose, app.purpose_other))
      row('Repayment period', app.repayment_period_months ? monthLabel(app.repayment_period_months) : null)

      y += 4
      heading('3. Financial information')
      row('Monthly income', tzs(app.monthly_income))
      row('Source of income', app.income_source)
      row('Monthly expenses', tzs(app.monthly_expenses))
      row(
        'Financial support',
        app.has_financial_support ? `${tzs(app.support_amount)} from ${app.support_source ?? '—'}` : 'None',
      )

      if (app.guarantor_full_name) {
        y += 4
        heading('4. Guarantor')
        row('Full name', app.guarantor_full_name)
        row('Relationship', app.guarantor_relationship)
        row('Phone', app.guarantor_phone)
        row('National ID', app.guarantor_national_id)
      }

      y += 4
      heading('5. Status')
      row('Status', STATUS_LABEL[app.status] ?? app.status)
      row('Submitted', app.submitted_at ? new Date(app.submitted_at).toLocaleString() : '—')
      row('Last updated', new Date(app.updated_at).toLocaleString())

      if (qr) {
        doc.addImage(qr, 'PNG', 148, 44, 44, 44)
        doc.setFontSize(7)
        doc.setTextColor(140)
        doc.text('Scan to confirm this', 148, 92)
        doc.text('application is genuine.', 148, 96)
      }

      doc.setFontSize(8)
      doc.setTextColor(140)
      doc.text(`${site.copyright} · ${site.developer}`, 14, 285)
      doc.save(`${app.application_number ?? 'draft'}.pdf`)
    } catch (e) {
      setPdfError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (error && !app) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Card title="We could not load your application">
          <ErrorNote error={error} onRetry={() => void load()} />
          <Link className="btn-blue" to="/dashboard">
            Back to dashboard
          </Link>
        </Card>
      </div>
    )
  }

  if (!app) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Card title="No application yet">
          <p className="text-sm text-slate-600">You have not started a loan application.</p>
          <Link className="btn-primary mt-4 inline-block" to="/loan/apply">
            APPLY FOR LOAN
          </Link>
        </Card>
      </div>
    )
  }

  const draft = app.status === 'DRAFT'
  const actionRequired = app.status === 'ACTION_REQUIRED'

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-navy">Your Loan Application</h1>
        <p className="mt-1 text-sm text-slate-600">
          {draft ? 'This is a draft. Nothing has been sent to OGESEOUS yet.' : 'Everything OGESEOUS currently holds about this application.'}
        </p>
      </header>

      {error && <ErrorNote error={error} onRetry={() => void load()} />}

      {!draft && (
        <div className="card border-green-300 bg-green-50">
          <p className="text-xs uppercase tracking-wide text-green-800">Application number</p>
          <p className="font-mono text-2xl font-bold text-navy">{app.application_number}</p>
          <p className="mt-2 text-sm text-green-900">
            Status:{' '}
            <span className="font-semibold">{STATUS_LABEL[app.status] ?? app.status}</span>
          </p>
          <p className="mt-1 text-xs text-green-900">
            Keep this number. Together with the phone number on your account it lets you track this
            application from the{' '}
            <Link className="underline" to="/track">
              public tracking page
            </Link>{' '}
            without signing in.
          </p>
        </div>
      )}

      {actionRequired && (
        <div className="card border-amber-300 bg-amber-50">
          <h2 className="font-semibold text-amber-900">OGESEOUS needs something from you</h2>
          <p className="mt-1 text-sm text-amber-900">{app.action_required_note ?? app.review_notes}</p>
          <button className="btn-primary mt-3" disabled={resubmitting} onClick={() => void resubmit()}>
            {resubmitting ? 'Sending…' : 'I have provided what was asked'}
          </button>
        </div>
      )}

      <Card
        title="Status"
        actions={<Badge tone={STATUS_TONE[app.status] ?? 'slate'}>{STATUS_LABEL[app.status] ?? app.status}</Badge>}
      >
        {STATUS_EXPLAIN[app.status] && (
          <p className="text-sm text-slate-600">{STATUS_EXPLAIN[app.status]}</p>
        )}
        <dl className="mt-3">
          <Row label="Submitted">{app.submitted_at ? dateTime(app.submitted_at) : 'Not submitted yet'}</Row>
          <Row label="Last updated">{dateTime(app.updated_at)}</Row>
          {app.review_notes && app.status !== 'ACTION_REQUIRED' && <Row label="Note from the office">{app.review_notes}</Row>}
        </dl>
        {draft && (
          <Link className="btn-primary mt-3 inline-block" to="/loan/apply">
            CONTINUE APPLICATION
          </Link>
        )}
      </Card>

      <Card
        title={draft ? 'What you have entered so far' : 'Details you submitted'}
        hint={draft ? 'Not sent to OGESEOUS. Edit any of it from the wizard.' : undefined}
      >
        <dl>
          <Row label="Full name">{profile?.full_name ?? '—'}</Row>
          <Row label="University">{universityName(profile?.university)}</Row>
          <Row label="Registration number">{profile?.registration_number ?? '—'}</Row>
          <Row label="Programme">{app.programme ?? '—'}</Row>
          <Row label="Year of study">{app.year_of_study ?? '—'}</Row>
          <Row label="Phone">{profile?.phone ?? '—'}</Row>
          <Row label="Address">{profile?.address ?? '—'}</Row>
          <Row label="Amount requested"><Money value={app.amount} /></Row>
          <Row label="Purpose">{purposeText(app.purpose, app.purpose_other)}</Row>
          <Row label="Repayment period">{app.repayment_period_months ? monthLabel(app.repayment_period_months) : '—'}</Row>
          <Row label="Monthly income"><Money value={app.monthly_income} /></Row>
          <Row label="Source of income">{app.income_source ?? '—'}</Row>
          <Row label="Monthly expenses"><Money value={app.monthly_expenses} /></Row>
          <Row label="Financial support">
            {app.has_financial_support ? `${tzs(app.support_amount)} from ${app.support_source ?? '—'}` : 'None'}
          </Row>
          <Row label="Guarantor">
            {app.guarantor_full_name
              ? `${app.guarantor_full_name} (${app.guarantor_relationship}) · ${app.guarantor_phone} · ID ${app.guarantor_national_id}`
              : 'None'}
          </Row>
        </dl>
      </Card>

      <Card title="Documents you uploaded">
        {docs.length === 0 ? (
          <p className="text-sm text-slate-600">No documents are attached to this application.</p>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li key={d.doc_type} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {APP_DOC_LABELS[d.doc_type as AppDocType] ?? d.doc_type}{' '}
                  <span className="text-xs text-slate-500">uploaded {dateTime(d.uploaded_at)}</span>
                </span>
                <button
                  className="btn-outline px-2 py-1 text-xs"
                  disabled={docBusy === d.doc_type}
                  onClick={() => void viewDoc(d)}
                >
                  {docBusy === d.doc_type ? 'Opening…' : 'View'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Each View creates a link that expires after a minute. There is no permanent link to your
          documents anywhere in this system.
        </p>
      </Card>

      <Card title="History" hint="Every change of status, and who made it.">
        {history.length === 0 ? (
          <p className="text-sm text-slate-600">Nothing has happened to this application yet.</p>
        ) : (
          <ol className="space-y-3">
            {history.map((h, i) => (
              <li key={i} className="border-l-2 border-slate-200 pl-3 text-sm">
                <p className="font-medium text-navy">
                  {h.from_status ? `${STATUS_LABEL[h.from_status] ?? h.from_status} → ` : ''}
                  {STATUS_LABEL[h.to_status] ?? h.to_status}
                </p>
                <p className="text-xs text-slate-500">
                  {dateTime(h.created_at)}
                  {h.actor_role === 'STUDENT' ? ' · by you' : h.actor_name ? ` · by ${h.actor_name}` : ''}
                </p>
                {h.note && <p className="mt-1 text-slate-600">{h.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="card">
        {qr ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <img
              src={qr}
              alt="QR code that verifies this application"
              className="h-[150px] w-[150px] rounded-lg border"
            />
            <div>
              <p className="text-sm text-slate-600">
                Anyone who scans this, or opens the public tracking page with your application number
                and phone number, can confirm that this application is genuine — without seeing your
                documents, your full name or your registration number.
              </p>
              <button
                className="btn-blue mt-3"
                disabled={busy || draft}
                onClick={() => void download()}
              >
                {draft ? 'Submit your application first' : busy ? 'Preparing PDF…' : 'Download application PDF'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-slate-600">
              {draft
                ? 'Your QR code and PDF appear once the application has been submitted.'
                : 'The QR code could not be generated on this device. The PDF still works.'}
            </p>
            <button className="btn-blue mt-3" disabled={busy || draft} onClick={() => void download()}>
              {draft ? 'Submit your application first' : busy ? 'Preparing PDF…' : 'Download application PDF'}
            </button>
          </div>
        )}
        {pdfError && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {pdfError}
          </p>
        )}
      </div>
    </div>
  )
}