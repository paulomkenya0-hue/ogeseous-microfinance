import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { describeError, rpc, tzs } from '../lib/api'
import { Badge, Card, ErrorNote, Money, Row, STATUS_TONE, dateTime, askReason, confirmAction } from '../components/ui'
import { ROLE_LABELS, universityName, type Role } from '../config/site'
import { openDocument } from '../lib/storage'
import { APP_DOC_LABELS, STATUS_EXPLAIN, STATUS_LABEL, monthLabel, purposeText, type AppDocType } from '../lib/application'

type Application = {
  id: string
  user_id: string
  application_number: string | null
  status: string
  amount: number | null
  purpose: string | null
  purpose_other: string | null
  repayment_period_months: number | null
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
  student_confirmed_at: string | null
  verification_method: string | null
  programme: string | null
  year_of_study: string | null
  submitted_at: string | null
  reviewed_at: string | null
  review_notes: string | null
  action_required_note: string | null
  created_at: string
  updated_at: string
}
type Applicant = {
  user_id: string
  full_name: string
  phone: string | null
  address: string | null
  university: string | null
  registration_number: string | null
  form_four_index_number: string | null
  programme: string | null
  year_of_study: string | null
  emergency_contact_name: string | null
  emergency_contact_relationship: string | null
  emergency_contact_phone: string | null
  email: string | null
  role: string
  account_status: string
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

const DECISIONS = [
  { value: 'UNDER_REVIEW', label: 'Keep under review', tone: 'btn-outline', needsNote: false },
  { value: 'ACTION_REQUIRED', label: 'Request information', tone: 'btn-primary', needsNote: true },
  { value: 'APPROVED', label: 'Approve', tone: 'btn-primary', needsNote: false },
  { value: 'REJECTED', label: 'Reject', tone: 'btn', needsNote: true },
] as const

/**
 * One application, for a loan officer, manager or super admin.
 *
 * Everything a decision needs is on this page: what was claimed, what was uploaded, and who
 * confirmed the student's identity. The two decisions that change the student's position require a
 * written reason, because both of them are shown to them — a rejection with no stated cause is the
 * single most common reason a student phones the office.
 *
 * Authorization is the database's, not this component's. loan_applications has a staff SELECT policy
 * (LOAN_OFFICER, MANAGER, SUPER_ADMIN), loan_documents has one too, and the documents themselves sit
 * behind the storage policy migration 014 added. If any of them refused, the error is shown rather
 * than rendered as an empty page.
 */
export default function AdminApplicationDetail() {
  const { id } = useParams<{ id: string }>()
  const [app, setApp] = useState<Application | null>(null)
  const [profile, setProfile] = useState<Applicant | null>(null)
  const [docs, setDocs] = useState<DocRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [docBusy, setDocBusy] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const aRes = await supabase.from('loan_applications').select('*').eq('id', id).maybeSingle()
      if (aRes.error) throw new Error(aRes.error.message)
      const row = aRes.data as Application | null
      setApp(row)

      if (!row) {
        setLoading(false)
        return
      }

      const [p, d, h] = await Promise.all([
        // The applicant's identity and contact details come from one purpose-built function rather
        // than from a direct read of student_profiles: that table's only read policy is "own row or
        // is_admin()", so a LOAN_OFFICER — the role that most needs this page — would get a refusal
        // for every applicant. See migration 014 section 20 for why the policy was not simply
        // loosened instead.
        rpc<Applicant>('application_student_detail', { p_application_id: id }),
        supabase.from('loan_documents').select('doc_type,storage_path,uploaded_at').eq('application_id', id),
        rpc<HistoryRow>('get_application_history', { p_id: id }),
      ])
      setProfile(p[0] ?? null)
      if (d.error) throw new Error(d.error.message)
      setDocs((d.data ?? []) as DocRow[])
      setHistory(h)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const viewDoc = async (d: DocRow) => {
    setDocBusy(d.doc_type)
    try {
      await openDocument(d.storage_path)
      setDocBusy('')
    } catch (e) {
      setDocBusy('')
      setError(describeError(e))
    }
  }

  const decide = async (decision: string, needsNote: boolean, label: string) => {
    if (!app) return
    let note: string | null = null
    if (needsNote) {
      const given = askReason(
        `${label}. This note is shown to the student, so say what they need to do.`,
        3,
      )
      if (given === null) return
      note = given
    } else if (decision === 'APPROVED') {
      if (
        !confirmAction(
          'Approve this application? Approval is a commitment to lend. Check the documents and the ' +
            'financial information first. This cannot be undone from here — only by voiding the ' +
            'disbursement, which is a separate audited action.',
        )
      )
        return
    }

    setBusy(decision)
    const { error: e } = await supabase.rpc('review_loan_application', {
      p_id: app.id,
      p_decision: decision,
      p_notes: note,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    await load()
  }

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>

  if (!app) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Card title="Application not found">
          <p className="text-sm text-slate-600">
            {error || 'This application does not exist, or your role cannot read it.'}
          </p>
          <Link className="btn-blue mt-4 inline-block" to="/admin/applications">
            Back to applications
          </Link>
        </Card>
      </div>
    )
  }

  const draft = app.status === 'DRAFT'
  const reviewable = ['SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED'].includes(app.status)

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin/applications" className="text-sm text-brand underline">
            ← All applications
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-bold text-navy">
            {app.application_number ?? 'Draft — not submitted'}
          </h1>
          <p className="text-sm text-slate-600">
            {profile?.full_name ?? 'Unknown student'} · submitted {app.submitted_at ? dateTime(app.submitted_at) : 'never'}
          </p>
        </div>
        <Badge tone={STATUS_TONE[app.status] ?? 'slate'}>{STATUS_LABEL[app.status] ?? app.status}</Badge>
      </header>

      {error && <ErrorNote error={error} onRetry={() => void load()} />}

      {draft && (
        <div className="card border-slate-300 bg-slate-50 text-sm text-slate-700">
          This student has not submitted yet. Nothing on this page has been sent to you by a
          deliberate act — it is a draft in progress, and it cannot be reviewed, approved or rejected
          until it is submitted.
        </div>
      )}

      <Card title="Decision">
        {!reviewable ? (
          <p className="text-sm text-slate-600">
            {STATUS_EXPLAIN[app.status]} No further review decision can be made from this page.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-600">{STATUS_EXPLAIN[app.status]}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {DECISIONS.map((d) => (
                <button
                  key={d.value}
                  className={`${d.tone} ${d.value === 'REJECTED' ? 'border border-red-300 text-red-700' : ''}`}
                  disabled={busy !== null || (d.value === 'UNDER_REVIEW' && app.status === 'UNDER_REVIEW')}
                  onClick={() => void decide(d.value, d.needsNote, d.label)}
                >
                  {busy === d.value ? 'Working…' : d.label}
                </button>
              ))}
            </div>
            {app.action_required_note && (
              <p className="mt-3 text-sm text-slate-700">
                <span className="font-medium">Currently asked of the student: </span>
                {app.action_required_note}
              </p>
            )}
          </>
        )}
        {app.review_notes && app.status !== 'ACTION_REQUIRED' && (
          <p className="mt-3 text-sm text-slate-700">
            <span className="font-medium">Last note: </span>
            {app.review_notes}
          </p>
        )}
      </Card>

      <Card title="Student">
        <dl>
          <Row label="Full name">{profile?.full_name ?? '—'}</Row>
          <Row label="Email">{profile?.email ?? '—'}</Row>
          <Row label="Phone">{profile?.phone ?? '—'}</Row>
          <Row label="Address">{profile?.address ?? '—'}</Row>
          <Row label="University">{universityName(profile?.university)}</Row>
          <Row label="Registration number">{profile?.registration_number ?? '—'}</Row>
          <Row label="Form Four index number">{profile?.form_four_index_number ?? '—'}</Row>
          <Row label="Programme">{app.programme ?? profile?.programme ?? '—'}</Row>
          <Row label="Year of study">{app.year_of_study ?? profile?.year_of_study ?? '—'}</Row>
          <Row label="Identity confirmed">
            {app.student_confirmed_at
              ? `${dateTime(app.student_confirmed_at)} — ${
                  app.verification_method === 'RUCU_REGISTER'
                    ? 'matched the RUCU register'
                    : 'self-declared, to be confirmed against these documents'
                }`
              : 'Not confirmed'}
          </Row>
          <Row label="Emergency contact">
            {profile?.emergency_contact_name
              ? `${profile.emergency_contact_name} (${profile.emergency_contact_relationship}) · ${profile.emergency_contact_phone}`
              : 'Not given'}
          </Row>
          <Row label="Account">{profile ? `${ROLE_LABELS[profile.role as Role] ?? profile.role} · ${profile.account_status}` : '—'}</Row>
        </dl>
      </Card>

      <Card title="Loan requested">
        <dl>
          <Row label="Amount"><Money value={app.amount} /></Row>
          <Row label="Purpose">{purposeText(app.purpose, app.purpose_other)}</Row>
          <Row label="Repayment period">{app.repayment_period_months ? monthLabel(app.repayment_period_months) : '—'}</Row>
        </dl>
      </Card>

      <Card title="Financial information">
        <dl>
          <Row label="Monthly income"><Money value={app.monthly_income} /></Row>
          <Row label="Source of income">{app.income_source ?? '—'}</Row>
          <Row label="Monthly expenses"><Money value={app.monthly_expenses} /></Row>
          <Row label="Surplus after expenses">
            {app.monthly_income !== null && app.monthly_expenses !== null ? (
              <Money value={app.monthly_income - app.monthly_expenses} />
            ) : (
              '—'
            )}
          </Row>
          <Row label="Financial support">
            {app.has_financial_support ? `${money(app.support_amount)} from ${app.support_source ?? '—'}` : 'None'}
          </Row>
        </dl>
        {app.monthly_income !== null && app.monthly_expenses !== null && app.monthly_expenses > app.monthly_income && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            Expenses exceed income by {money(app.monthly_expenses - app.monthly_income)} a month. Worth
            discussing before approving.
          </p>
        )}
      </Card>

      <Card title="Guarantor">
        {app.guarantor_full_name ? (
          <dl>
            <Row label="Full name">{app.guarantor_full_name}</Row>
            <Row label="Relationship">{app.guarantor_relationship ?? '—'}</Row>
            <Row label="Phone">{app.guarantor_phone ?? '—'}</Row>
            <Row label="National ID">{app.guarantor_national_id ?? '—'}</Row>
            <Row label="Address">{app.guarantor_address ?? '—'}</Row>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">No guarantor recorded.</p>
        )}
      </Card>

      <Card title="Documents" hint="Opened through a short-lived link. Never a public URL.">
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
      </Card>

      <Card title="History">
        {history.length === 0 ? (
          <p className="text-sm text-slate-600">No status changes recorded.</p>
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
                  {h.actor_role === 'STUDENT' ? ' · by the student' : h.actor_name ? ` · by ${h.actor_name}` : ''}
                </p>
                {h.note && <p className="mt-1 text-slate-600">{h.note}</p>}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Created {dateTime(app.created_at)} · last updated {dateTime(app.updated_at)}
        </p>
      </Card>
    </div>
  )
}

/** tzs() with a dash for absent values — an unset optional figure is not a zero. */
function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : tzs(value)
}