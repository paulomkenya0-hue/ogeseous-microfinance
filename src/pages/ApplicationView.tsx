import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, tzs } from '../lib/api'
import { site, universityName } from '../config/site'

type App = {
  id: string
  application_number: string | null
  verification_token: string | null
  amount: number
  purpose: string
  purpose_other: string | null
  repayment_period_months: number
  status: string
  submitted_at: string | null
  review_notes: string | null
}
type Profile = { full_name: string; university: string | null; registration_number: string | null }

const PURPOSE_LABEL: Record<string, string> = {
  TUITION_FEES: 'Tuition fees',
  ACCOMMODATION: 'Accommodation',
  BOOKS_AND_MATERIALS: 'Books & learning materials',
  OTHER: 'Other',
}
const purposeText = (a: Pick<App, 'purpose' | 'purpose_other'>) =>
  a.purpose === 'OTHER' ? a.purpose_other || 'Other' : PURPOSE_LABEL[a.purpose] ?? a.purpose

export default function ApplicationView() {
  const { session } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [qr, setQr] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pdfError, setPdfError] = useState('')

  useEffect(() => {
    if (!session) return
    let active = true

    const run = async () => {
      const uid = session.user.id
      const [a, p] = await Promise.all([
        supabase
          .from('loan_applications')
          .select(
            'id,application_number,verification_token,amount,purpose,purpose_other,repayment_period_months,status,submitted_at,review_notes',
          )
          .eq('user_id', uid)
          .maybeSingle(),
        supabase.from('student_profiles').select('full_name,university,registration_number').eq('user_id', uid).single(),
      ])
      if (!active) return
      if (a.error) setError(describeError(a.error))
      setApp(a.data as App | null)
      setProfile(p.data as Profile | null)
      setLoading(false)
    }

    void run()
    return () => {
      active = false
    }
  }, [session])

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

  const download = async () => {
    if (!app || !profile) return
    setBusy(true)
    setPdfError('')
    try {
      // Loaded on demand. jsPDF drags in html2canvas and DOMPurify — about 350KB — and importing
      // it at module scope put that cost on every page of the app, for students who never open
      // this one. (The installed 2.5.2 also carries a critical advisory; see SECURITY.md.)
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

      y += 4
      heading('2. Loan details')
      row('Amount requested', tzs(app.amount))
      row('Purpose', purposeText(app))
      row('Repayment period', `${app.repayment_period_months} months`)

      y += 4
      heading('3. Status')
      row('Status', app.status)
      row('Submitted', app.submitted_at ? new Date(app.submitted_at).toLocaleString() : '—')

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
  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">We could not load your application</h1>
          <p className="mt-2 text-sm text-slate-600">{error}</p>
        </div>
      </div>
    )
  }
  if (!app) return <p className="p-10 text-center text-slate-600">No loan application found.</p>

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-4 text-2xl font-bold text-navy">Your Loan Application</h1>

      <div className="card grid gap-4 sm:grid-cols-[1fr_150px]">
        <div className="space-y-1 text-sm">
          <p>
            <b>Application no.:</b> {app.application_number ?? 'Not yet submitted'}
          </p>
          <p>
            <b>Full name:</b> {profile?.full_name ?? '—'}
          </p>
          <p>
            <b>University:</b> {universityName(profile?.university)}
          </p>
          <p>
            <b>Registration no.:</b> {profile?.registration_number ?? '—'}
          </p>
          <p>
            <b>Amount:</b> {tzs(app.amount)}
          </p>
          <p>
            <b>Purpose:</b> {purposeText(app)}
          </p>
          <p>
            <b>Repayment period:</b> {app.repayment_period_months} months
          </p>
          <p>
            <b>Status:</b> {app.status.replace('_', ' ').toLowerCase()}
          </p>
          {app.review_notes && (
            <p className="pt-1 text-slate-600">
              <b>Note from the office:</b> {app.review_notes}
            </p>
          )}
        </div>

        {qr ? (
          <img src={qr} alt="QR code that verifies this application" className="h-[150px] w-[150px] self-start justify-self-end rounded-lg border" />
        ) : (
          <div className="grid h-[150px] w-[150px] place-items-center self-start justify-self-end rounded-lg border-2 border-dashed border-slate-300 text-xs text-slate-400">
            QR appears after submission
          </div>
        )}
      </div>

      {app.status === 'DRAFT' && (
        <p className="mt-4 text-sm text-slate-600">
          This is still a draft. Go back to the application to submit it — the PDF and QR code are
          generated once it has been submitted.
        </p>
      )}

      <button className="btn-blue mt-4 w-full" disabled={busy || app.status === 'DRAFT'} onClick={() => void download()}>
        {app.status === 'DRAFT'
          ? 'Submit your application first'
          : busy
            ? 'Preparing PDF…'
            : 'Download application PDF'}
      </button>

      {pdfError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {pdfError}
        </p>
      )}
    </div>
  )
}
