import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { jsPDF } from 'jspdf'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { site } from '../config/site'

type App = {
  id: string; application_number: string | null; verification_token: string | null; amount: number
  purpose: string; purpose_other: string | null; repayment_period_months: number; status: string; submitted_at: string | null
}
type Profile = { full_name: string; university: string; registration_number: string }

const purposeLabel: Record<string, string> = { TUITION_FEES: 'Tuition Fees', ACCOMMODATION: 'Accommodation', BOOKS_AND_MATERIALS: 'Books & Learning Materials', OTHER: 'Other' }

export default function ApplicationView() {
  const { session } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [qr, setQr] = useState<string>(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([
      supabase.from('loan_applications').select('id,application_number,verification_token,amount,purpose,purpose_other,repayment_period_months,status,submitted_at').eq('user_id', session!.user.id).maybeSingle(),
      supabase.from('student_profiles').select('full_name,university,registration_number').eq('user_id', session!.user.id).single(),
    ]).then(([a, p]) => { setApp(a.data as App); setProfile(p.data as Profile); setLoading(false) })
  }, [session])

  useEffect(() => {
    if (!app?.application_number || !app.verification_token) return
    const url = `${window.location.origin}/verify?app=${encodeURIComponent(app.application_number)}&token=${encodeURIComponent(app.verification_token)}`
    QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''))
  }, [app])

  const download = async () => {
    if (!app || !profile) return
    setBusy(true)
    try {
      const doc = new jsPDF()
      doc.setFontSize(16); doc.setTextColor(11, 42, 91); doc.text(site.name, 14, 18)
      doc.setFontSize(10); doc.setTextColor(90); doc.text(site.tagline, 14, 24)
      doc.setDrawColor(220); doc.line(14, 28, 196, 28)
      doc.setFontSize(13); doc.setTextColor(20); doc.text('Student Loan Application Form', 14, 38)

      let y = 50
      const row = (label: string, val: string) => { doc.setFontSize(10); doc.setTextColor(100); doc.text(label, 14, y); doc.setTextColor(20); doc.text(val || '-', 70, y); y += 8 }
      doc.setFontSize(11); doc.setTextColor(11, 42, 91); doc.text('1. Student Details', 14, y); y += 8
      row('Application No.', app.application_number || 'Not submitted')
      row('Full Name', profile.full_name); row('University', profile.university); row('Registration No.', profile.registration_number)
      y += 4; doc.setFontSize(11); doc.setTextColor(11, 42, 91); doc.text('2. Loan Details', 14, y); y += 8
      row('Amount Requested', `TZS ${Number(app.amount).toLocaleString()}`)
      row('Purpose', app.purpose === 'OTHER' ? (app.purpose_other || 'Other') : purposeLabel[app.purpose])
      row('Repayment Period', `${app.repayment_period_months} Months`)
      row('Status', app.status); row('Submitted', app.submitted_at ? new Date(app.submitted_at).toLocaleString() : '-')

      if (qr) doc.addImage(qr, 'PNG', 150, 45, 40, 40)
      doc.setFontSize(8); doc.setTextColor(140); doc.text('Scan the QR code to verify this application is genuine.', 150, 90)
      doc.setFontSize(8); doc.text(`${site.copyright} · ${site.developer}`, 14, 285)
      doc.save(`${app.application_number || 'draft'}.pdf`)
    } finally { setBusy(false) }
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>
  if (!app) return <p className="p-10 text-center text-slate-600">No loan application found.</p>

  return <div className="mx-auto max-w-2xl px-4 py-10">
    <h1 className="mb-4 text-2xl font-bold text-navy">Your Loan Application</h1>
    <div className="card grid gap-4 sm:grid-cols-[1fr_140px]">
      <div className="space-y-1 text-sm">
        <p><b>Application No.:</b> {app.application_number || 'Not yet submitted'}</p>
        <p><b>Full Name:</b> {profile?.full_name}</p>
        <p><b>University:</b> {profile?.university}</p>
        <p><b>Registration No.:</b> {profile?.registration_number}</p>
        <p><b>Amount:</b> TZS {Number(app.amount).toLocaleString()}</p>
        <p><b>Purpose:</b> {app.purpose === 'OTHER' ? app.purpose_other : purposeLabel[app.purpose]}</p>
        <p><b>Repayment Period:</b> {app.repayment_period_months} Months</p>
        <p><b>Status:</b> {app.status}</p>
      </div>
      {qr ? <img src={qr} alt="Verification QR code" className="h-[140px] w-[140px] self-start justify-self-end rounded-lg border" />
        : <div className="grid h-[140px] w-[140px] place-items-center self-start justify-self-end rounded-lg border-2 border-dashed border-slate-300 text-xs text-slate-400">QR after submission</div>}
    </div>
    <button className="btn-blue mt-4 w-full" disabled={busy || app.status === 'DRAFT'} onClick={download}>
      {app.status === 'DRAFT' ? 'Submit your application to enable download' : busy ? 'Preparing PDF…' : 'Download Application PDF'}
    </button>
  </div>
}
