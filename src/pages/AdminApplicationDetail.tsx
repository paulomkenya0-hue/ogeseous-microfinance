import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc, rpcOne } from '../lib/api'
import {
  Badge,
  Card,
  ErrorNote,
  Money,
  Row,
  STATUS_TONE,
  askReason,
  confirmAction,
  dateTime,
} from '../components/ui'
import { ROLE_LABELS, universityName, type Role } from '../config/site'
import { openDocument, openPaymentProof, uploadPaymentProof } from '../lib/storage'
import {
  ACCOUNTANT_DISBURSE_STATUSES,
  ACCOUNTANT_TERMS_STATUSES,
  APP_DOC_LABELS,
  LOAN_OFFICER_ACTION_STATUSES,
  MANAGER_ACTION_STATUSES,
  STATUS_EXPLAIN,
  STATUS_LABEL,
  TERMS_STATUS_LABEL,
  isOneOf,
  monthsLabel,
  purposeText,
  type AppDocType,
} from '../lib/application'

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
type WorkflowRow = {
  stage: string
  from_status: string | null
  to_status: string
  actor_name: string | null
  actor_role: string | null
  comment: string | null
  created_at: string
}
type Terms = {
  terms_id: string
  tranche_no: number
  status: string
  principal_amount: number
  annual_rate: number
  period_months: number
  installment_amount: number
  total_interest: number
  total_repayable: number
  prepared_at: string | null
  approved_at: string | null
  accepted_at: string | null
  manager_comment: string | null
  accountant_comment: string | null
  return_reason: string | null
}
type Disbursement = {
  id: string
  tranche_no: number
  amount: number
  channel: string
  reference: string | null
  proof_path: string | null
  status: string
  disbursed_at: string
  void_reason: string | null
}
type Loan = {
  id: string
  principal_amount: number
  outstanding_balance: number
  total_interest: number
  total_repayable: number
  status: string
  disbursed_at: string | null
  paid_off_at: string | null
}
type Policy = { annual_interest_rate: number; periods: number[] }
type Quote = { installment_amount: number; total_interest: number; total_repayable: number }

const CHANNELS: [string, string][] = [
  ['MOBILE_MONEY', 'Mobile money'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['CASH', 'Cash'],
  ['CHEQUE', 'Cheque'],
]

const termTone = (status: string) => STATUS_TONE[status] ?? 'slate'

/**
 * One application, for every role in the sequential workflow.
 *
 * The page is the same file for all of them because the application is the same file: a loan
 * officer forwards it, a manager decides it and later approves the terms, an accountant prepares
 * those terms and disburses each tranche, and finally closes the loan after reconciliation. What
 * changes by role is which controls are offered — and the database refuses anything this page gets
 * wrong, so a missing control is convenience rather than security.
 *
 * Every action here calls an RPC that re-checks the role, the current status and the two-person
 * rules. Nothing is decided by the browser.
 */
export default function AdminApplicationDetail() {
  const { id } = useParams<{ id: string }>()
  const { role, session } = useAuth()

  const [app, setApp] = useState<Application | null>(null)
  const [profile, setProfile] = useState<Applicant | null>(null)
  const [docs, setDocs] = useState<DocRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [workflow, setWorkflow] = useState<WorkflowRow[]>([])
  const [terms, setTerms] = useState<Terms[]>([])
  const [disbursements, setDisbursements] = useState<Disbursement[]>([])
  const [loan, setLoan] = useState<Loan | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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

      const [p, d, h, w, t, disb, loanRes, pol] = await Promise.all([
        // application_student_detail() is the purpose-built reader for staff: student_profiles is
        // readable by the student or an admin only, so a loan officer cannot select it directly.
        rpc<Applicant>('application_student_detail', { p_application_id: id }),
        supabase.from('loan_documents').select('doc_type,storage_path,uploaded_at').eq('application_id', id),
        rpc<HistoryRow>('get_application_history', { p_id: id }),
        rpc<WorkflowRow>('get_application_workflow', { p_application_id: id }),
        rpc<Terms>('get_application_terms', { p_application_id: id }),
        supabase
          .from('disbursements')
          .select('id,tranche_no,amount,channel,reference,proof_path,status,disbursed_at,void_reason')
          .eq('application_id', id)
          .order('tranche_no'),
        supabase
          .from('loans')
          .select('id,principal_amount,outstanding_balance,total_interest,total_repayable,status,disbursed_at,paid_off_at')
          .eq('application_id', id)
          .maybeSingle(),
        rpcOne<Policy>('loan_policy').catch(() => null),
      ])

      setProfile(p[0] ?? null)
      if (d.error) throw new Error(d.error.message)
      if (disb.error) throw new Error(disb.error.message)
      if (loanRes.error) throw new Error(loanRes.error.message)

      setDocs((d.data ?? []) as DocRow[])
      setHistory(h)
      setWorkflow(w)
      setTerms(t)
      setDisbursements((disb.data ?? []) as Disbursement[])
      setLoan((loanRes.data as Loan | null) ?? null)
      setPolicy(pol)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const viewDoc = async (path: string, key: string) => {
    setDocBusy(key)
    try {
      await openDocument(path)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setDocBusy('')
    }
  }

  const viewProof = async (path: string) => {
    setDocBusy(path)
    try {
      await openPaymentProof(path)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setDocBusy('')
    }
  }

  // ---------------------------------------------------------------------------------------
  // Role gates. The RPCs enforce these again; these flags only decide what to render.
  // ---------------------------------------------------------------------------------------
  const isSuper = role === 'SUPER_ADMIN'
  const canLoanOfficer = role === 'LOAN_OFFICER' || isSuper
  const canManager = role === 'MANAGER' || isSuper
  const canAccountant = role === 'ACCOUNTANT' || isSuper

  const status = app?.status ?? ''
  const officerCanAct = canLoanOfficer && isOneOf(LOAN_OFFICER_ACTION_STATUSES, status)
  const managerCanDecide = canManager && isOneOf(MANAGER_ACTION_STATUSES, status)

  const activeTerms = useMemo(() => terms.filter((t) => t.status !== 'VOIDED'), [terms])
  const committed = activeTerms.reduce((sum, t) => sum + Number(t.principal_amount), 0)
  const requested = Number(app?.amount ?? 0)
  const remaining = Math.max(0, Math.round((requested - committed) * 100) / 100)

  const draftTerms = terms.find((t) => t.status === 'DRAFT_TERMS') ?? null
  const managerTerms = canManager
    ? terms.filter((t) => t.status === 'PENDING_MANAGER_TERMS')
    : []
  const disburseableTerms = canAccountant
    ? terms.filter((t) => t.status === 'ACCEPTED_BY_STUDENT')
    : []

  const accountantCanPrepare =
    canAccountant &&
    (isOneOf(ACCOUNTANT_TERMS_STATUSES, status) || (status === 'DISBURSED' && remaining > 0.01))

  const canClose = canAccountant && loan?.status === 'PAID_OFF'

  // ---------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------
  const forward = async () => {
    if (!app) return
    const comment = askReason(
      'Your assessment note for the manager. It is mandatory and is kept in the workflow record.',
      5,
    )
    if (comment === null) return
    if (
      !confirmAction(
        'Forward this application to the manager? Check the documents and the financial picture first. ' +
          'The manager cannot see anything you have not verified here.',
      )
    )
      return

    setBusy('forward')
    const { error: e } = await supabase.rpc('forward_application_to_manager', {
      p_id: app.id,
      p_comment: comment,
      p_confirm: true,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice('Forwarded to the manager.')
    await load()
  }

  const rejectAtOfficer = async () => {
    if (!app) return
    const comment = askReason('Reason for rejection. This is shown to the student.', 5)
    if (comment === null) return
    setBusy('reject')
    const { error: e } = await supabase.rpc('loan_officer_reject_application', {
      p_id: app.id,
      p_comment: comment,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice('Application rejected. The student can see the reason.')
    await load()
  }

  const returnToStudent = async () => {
    if (!app) return
    const note = askReason(
      'What does the student need to supply or correct? This note is shown to them.',
      5,
    )
    if (note === null) return
    setBusy('return-student')
    const { error: e } = await supabase.rpc('return_application_to_student', {
      p_id: app.id,
      p_note: note,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice('Returned to the student with your note.')
    await load()
  }

  const managerDecide = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    if (!app) return
    const comment = askReason(
      decision === 'REJECT'
        ? 'Reason for rejection. This is shown to the student.'
        : decision === 'RETURN'
          ? 'What must the loan officer redo? This note is kept in the workflow record.'
          : 'Comment for the record. It is mandatory at this stage.',
      5,
    )
    if (comment === null) return
    if (
      decision === 'APPROVE' &&
      !confirmAction(
        'Approve this application for the accountant to prepare terms? This is the credit decision. ' +
          'The interest rate is NOT set here — the accountant proposes it and you approve it separately.',
      )
    )
      return

    setBusy(`manager-${decision}`)
    const { error: e } = await supabase.rpc('manager_decide_application', {
      p_id: app.id,
      p_decision: decision,
      p_comment: comment,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice(
      decision === 'APPROVE'
        ? 'Approved. The accountant will prepare the terms.'
        : decision === 'REJECT'
          ? 'Application rejected.'
          : 'Returned to the loan officer.',
    )
    await load()
  }

  const approveTerms = async (t: Terms) => {
    if (!confirmAction(`Approve the terms for tranche ${t.tranche_no}? The student is then asked to accept them.`))
      return
    setBusy(`terms-approve-${t.terms_id}`)
    const { error: e } = await supabase.rpc('manager_approve_terms', {
      p_terms_id: t.terms_id,
      p_comment: null,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice(`Tranche ${t.tranche_no} terms approved and sent to the student.`)
    await load()
  }

  const returnTerms = async (t: Terms) => {
    const reason = askReason('Why are these terms being returned to the accountant?', 5)
    if (reason === null) return
    setBusy(`terms-return-${t.terms_id}`)
    const { error: e } = await supabase.rpc('manager_return_terms', {
      p_terms_id: t.terms_id,
      p_reason: reason,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice(`Tranche ${t.tranche_no} terms returned to the accountant.`)
    await load()
  }

  const closeLoan = async () => {
    if (!loan) return
    const note = askReason(
      'Reconciliation note. Confirm you have checked every repayment and the final balance.',
      5,
    )
    if (note === null) return
    if (!confirmAction('Close this loan? This is the final reconciliation and cannot be undone.')) return
    setBusy('close')
    const { error: e } = await supabase.rpc('close_loan', { p_loan_id: loan.id, p_note: note })
    setBusy(null)
    if (e) return setError(describeError(e))
    setNotice('Loan closed and reconciled.')
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
  const timeline = workflow.length > 0 ? workflow : []
  const anyAction =
    officerCanAct ||
    managerCanDecide ||
    managerTerms.length > 0 ||
    accountantCanPrepare ||
    disburseableTerms.length > 0 ||
    canClose

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
            {profile?.full_name ?? 'Unknown student'} · submitted{' '}
            {app.submitted_at ? dateTime(app.submitted_at) : 'never'}
          </p>
        </div>
        <Badge tone={STATUS_TONE[app.status] ?? 'slate'}>{STATUS_LABEL[app.status] ?? app.status}</Badge>
      </header>

      {error && <ErrorNote error={error} onRetry={() => void load()} />}
      {notice && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      {draft && (
        <div className="card border-slate-300 bg-slate-50 text-sm text-slate-700">
          This student has not submitted yet. Nothing on this page has been sent to you by a
          deliberate act — it is a draft in progress, and it cannot be reviewed, approved or rejected
          until it is submitted.
        </div>
      )}

      <Card
        title="Workflow"
        hint="Each stage is recorded with the officer, the time and the handover comment."
      >
        <p className="text-sm text-slate-600">{STATUS_EXPLAIN[app.status] ?? ''}</p>

        {!anyAction && (
          <p className="mt-3 text-sm text-slate-500">
            No action is available to your role at this stage. The application is waiting for{' '}
            {STATUS_LABEL[app.status]?.toLowerCase() ?? 'the next stage'}.
          </p>
        )}

        {officerCanAct && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy !== null} onClick={() => void forward()}>
              {busy === 'forward' ? 'Forwarding…' : 'Forward to manager'}
            </button>
            <button className="btn-outline" disabled={busy !== null} onClick={() => void returnToStudent()}>
              {busy === 'return-student' ? 'Returning…' : 'Request information from student'}
            </button>
            <button
              className="btn border border-red-300 text-red-700"
              disabled={busy !== null}
              onClick={() => void rejectAtOfficer()}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject application'}
            </button>
          </div>
        )}

        {managerCanDecide && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => void managerDecide('APPROVE')}
            >
              {busy === 'manager-APPROVE' ? 'Approving…' : 'Approve for terms'}
            </button>
            <button
              className="btn-outline"
              disabled={busy !== null}
              onClick={() => void managerDecide('RETURN')}
            >
              {busy === 'manager-RETURN' ? 'Returning…' : 'Return to loan officer'}
            </button>
            <button
              className="btn border border-red-300 text-red-700"
              disabled={busy !== null}
              onClick={() => void managerDecide('REJECT')}
            >
              {busy === 'manager-REJECT' ? 'Rejecting…' : 'Reject application'}
            </button>
          </div>
        )}

        {app.action_required_note && app.status === 'ACTION_REQUIRED' && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <span className="font-medium">Asked of the student: </span>
            {app.action_required_note}
          </p>
        )}
        {app.review_notes && app.status === 'REJECTED' && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
            <span className="font-medium">Rejection reason: </span>
            {app.review_notes}
          </p>
        )}
      </Card>

      {canAccountant && (accountantCanPrepare || draftTerms) && (
        <TermsForm
          applicationId={app.id}
          requested={requested}
          remaining={remaining}
          draft={draftTerms}
          defaultRate={policy?.annual_interest_rate ?? 0}
          allowedPeriods={(policy?.periods ?? [1, 2, 3]).filter((m) => [1, 2, 3].includes(m))}
          busy={busy}
          setBusy={setBusy}
          onDone={async (message) => {
            setNotice(message)
            await load()
          }}
          onError={setError}
        />
      )}

      {(terms.length > 0 || disbursements.length > 0) && (
        <Card
          title="Loan terms and tranches"
          hint="Each tranche has its own terms, manager approval and student acceptance."
        >
          {terms.length === 0 ? (
            <p className="text-sm text-slate-600">No terms have been prepared yet.</p>
          ) : (
            <ul className="space-y-3">
              {terms.map((t) => {
                const disb = disbursements.find((d) => d.tranche_no === t.tranche_no)
                const canApprove = canManager && t.status === 'PENDING_MANAGER_TERMS'
                const canDisburse =
                  canAccountant &&
                  t.status === 'ACCEPTED_BY_STUDENT' &&
                  isOneOf(ACCOUNTANT_DISBURSE_STATUSES, app.status)
                return (
                  <li key={t.terms_id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-navy">Tranche {t.tranche_no}</p>
                        <p className="text-xs text-slate-500">
                          Prepared {dateTime(t.prepared_at)}
                          {t.approved_at ? ` · approved ${dateTime(t.approved_at)}` : ''}
                          {t.accepted_at ? ` · accepted ${dateTime(t.accepted_at)}` : ''}
                        </p>
                      </div>
                      <Badge tone={termTone(t.status)}>
                        {TERMS_STATUS_LABEL[t.status] ?? t.status}
                      </Badge>
                    </div>

                    <dl className="mt-2">
                      <Row label="Principal">
                        <Money value={t.principal_amount} />
                      </Row>
                      <Row label="Interest rate">{t.annual_rate}% a year, reducing balance</Row>
                      <Row label="Repayment period">{monthsLabel(t.period_months)}</Row>
                      <Row label="Monthly installment">
                        <Money value={t.installment_amount} />
                      </Row>
                      <Row label="Total interest">
                        <Money value={t.total_interest} />
                      </Row>
                      <Row label="Total repayable">
                        <Money value={t.total_repayable} />
                      </Row>
                      {t.accountant_comment && <Row label="Accountant's note">{t.accountant_comment}</Row>}
                      {t.manager_comment && <Row label="Manager's comment">{t.manager_comment}</Row>}
                      {t.return_reason && <Row label="Returned because">{t.return_reason}</Row>}
                    </dl>

                    {canApprove && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="btn-primary px-3 py-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => void approveTerms(t)}
                        >
                          {busy === `terms-approve-${t.terms_id}` ? 'Approving…' : 'Approve terms'}
                        </button>
                        <button
                          className="btn-outline px-3 py-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => void returnTerms(t)}
                        >
                          {busy === `terms-return-${t.terms_id}` ? 'Returning…' : 'Return for correction'}
                        </button>
                      </div>
                    )}

                    {canDisburse && (
                      <DisburseForm
                        terms={t}
                        remaining={remaining}
                        userId={session!.user.id}
                        busy={busy}
                        setBusy={setBusy}
                        onDone={async (message) => {
                          setNotice(message)
                          await load()
                        }}
                        onError={setError}
                      />
                    )}

                    {disb && (
                      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
                        <p className="font-medium text-navy">
                          Disbursement {disb.status === 'VOIDED' ? '(voided)' : ''}
                        </p>
                        <p className="text-xs text-slate-600">
                          <Money value={disb.amount} /> · {disb.channel.replace('_', ' ').toLowerCase()} ·{' '}
                          {dateTime(disb.disbursed_at)}
                          {disb.reference ? ` · ref ${disb.reference}` : ''}
                        </p>
                        {disb.void_reason && (
                          <p className="text-xs text-red-700">Voided: {disb.void_reason}</p>
                        )}
                        {disb.proof_path && (
                          <button
                            className="btn-outline mt-2 px-2 py-1 text-xs"
                            disabled={docBusy === disb.proof_path}
                            onClick={() => void viewProof(disb.proof_path!)}
                          >
                            {docBusy === disb.proof_path ? 'Opening…' : 'View proof'}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {remaining > 0.01 && app.status === 'DISBURSED' && (
            <p className="mt-3 text-xs text-slate-500">
              <Money value={remaining} /> of the requested amount has not been put into terms yet.
              The accountant can prepare another tranche.
            </p>
          )}
        </Card>
      )}

      {loan && (
        <Card title="Loan">
          <dl>
            <Row label="Status">
              <Badge tone={STATUS_TONE[loan.status] ?? 'slate'}>{loan.status}</Badge>
            </Row>
            <Row label="Principal"><Money value={loan.principal_amount} /></Row>
            <Row label="Total interest"><Money value={loan.total_interest} /></Row>
            <Row label="Total repayable"><Money value={loan.total_repayable} /></Row>
            <Row label="Outstanding"><Money value={loan.outstanding_balance} /></Row>
            <Row label="First disbursed">{dateTime(loan.disbursed_at)}</Row>
            {loan.paid_off_at && <Row label="Paid off">{dateTime(loan.paid_off_at)}</Row>}
          </dl>
          {canClose && (
            <div className="mt-3 rounded-lg border border-green-300 bg-green-50 p-3">
              <p className="text-sm text-green-900">
                Every installment is paid. The final step is to reconcile the file and close the
                loan. This records what was collected and is the end of the workflow.
              </p>
              <button
                className="btn-primary mt-2 px-3 py-1 text-xs"
                disabled={busy !== null}
                onClick={() => void closeLoan()}
              >
                {busy === 'close' ? 'Closing…' : 'Reconcile and close loan'}
              </button>
            </div>
          )}
        </Card>
      )}

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
          <Row label="Account">
            {profile
              ? `${ROLE_LABELS[profile.role as Role] ?? profile.role} · ${profile.account_status}`
              : '—'}
          </Row>
        </dl>
      </Card>

      <Card title="Loan requested">
        <dl>
          <Row label="Amount"><Money value={app.amount} /></Row>
          <Row label="Purpose">{purposeText(app.purpose, app.purpose_other)}</Row>
          <Row label="Requested repayment period">
            {app.repayment_period_months ? monthsLabel(app.repayment_period_months) : '—'}
          </Row>
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
            {app.has_financial_support
              ? `${money(app.support_amount)} from ${app.support_source ?? '—'}`
              : 'None'}
          </Row>
        </dl>
        {app.monthly_income !== null &&
          app.monthly_expenses !== null &&
          app.monthly_expenses > app.monthly_income && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              Expenses exceed income by {money(app.monthly_expenses - app.monthly_income)} a month.
              Worth discussing before approving.
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
                  onClick={() => void viewDoc(d.storage_path, d.doc_type)}
                >
                  {docBusy === d.doc_type ? 'Opening…' : 'View'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="History">
        {timeline.length === 0 && history.length === 0 ? (
          <p className="text-sm text-slate-600">No status changes recorded.</p>
        ) : timeline.length > 0 ? (
          <ol className="space-y-3">
            {timeline.map((w, i) => (
              <li key={i} className="border-l-2 border-slate-200 pl-3 text-sm">
                <p className="font-medium text-navy">
                  {w.from_status ? `${STATUS_LABEL[w.from_status] ?? w.from_status} → ` : ''}
                  {STATUS_LABEL[w.to_status] ?? w.to_status}
                </p>
                <p className="text-xs text-slate-500">
                  {dateTime(w.created_at)} · {w.stage.replace(/_/g, ' ').toLowerCase()}
                  {w.actor_role === 'STUDENT'
                    ? ' · by the student'
                    : w.actor_name
                      ? ` · by ${w.actor_name}`
                      : ''}
                </p>
                {w.comment && <p className="mt-1 text-slate-600">{w.comment}</p>}
              </li>
            ))}
          </ol>
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
                  {h.actor_role === 'STUDENT'
                    ? ' · by the student'
                    : h.actor_name
                      ? ` · by ${h.actor_name}`
                      : ''}
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

// ---------------------------------------------------------------------------------------
// Accountant: prepare terms for the first or next tranche.
// ---------------------------------------------------------------------------------------
function TermsForm({
  applicationId,
  requested,
  remaining,
  draft,
  defaultRate,
  allowedPeriods,
  busy,
  setBusy,
  onDone,
  onError,
}: {
  applicationId: string
  requested: number
  remaining: number
  draft: Terms | null
  defaultRate: number
  allowedPeriods: number[]
  busy: string | null
  setBusy: (v: string | null) => void
  onDone: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const periods = allowedPeriods.length > 0 ? allowedPeriods : [1, 2, 3]
  const [principal, setPrincipal] = useState('')
  const [rate, setRate] = useState('')
  const [months, setMonths] = useState('')
  const [comment, setComment] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoteError, setQuoteError] = useState('')

  // Prefill from the returned draft, or from what is left of the requested amount.
  useEffect(() => {
    setPrincipal(String(draft?.principal_amount ?? (remaining > 0.01 ? remaining : requested)))
    setRate(String(draft?.annual_rate ?? defaultRate))
    setMonths(String(draft?.period_months ?? periods[0] ?? 1))
    setComment(draft?.accountant_comment ?? '')
  }, [draft, remaining, requested, defaultRate, periods])

  useEffect(() => {
    const p = Number(principal)
    const r = Number(rate)
    const m = Number(months)
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(r) || r < 0 || !Number.isFinite(m) || m <= 0) {
      setQuote(null)
      setQuoteError('')
      return
    }
    let active = true
    rpcOne<Quote>('loan_quote', { p_principal: p, p_annual_rate: r, p_months: m })
      .then((q) => {
        if (!active) return
        setQuote(q)
        setQuoteError('')
      })
      .catch((e) => {
        if (!active) return
        setQuote(null)
        setQuoteError(describeError(e))
      })
    return () => {
      active = false
    }
  }, [principal, rate, months])

  const submit = async () => {
    const p = Number(principal)
    const r = Number(rate)
    const m = Number(months)
    if (!Number.isFinite(p) || p <= 0) return onError('Enter the amount to be paid out in this tranche.')
    if (!Number.isFinite(r) || r < 0) return onError('Enter the annual interest rate for this tranche.')
    if (!periods.includes(m)) return onError('Choose a repayment period of 1, 2 or 3 months.')

    setBusy('terms')
    const { error } = await supabase.rpc('accountant_prepare_terms', {
      p_application_id: applicationId,
      p_principal: p,
      p_annual_rate: r,
      p_period_months: m,
      p_comment: comment.trim() || null,
      p_terms_id: draft?.terms_id ?? null,
    })
    setBusy(null)
    if (error) return onError(describeError(error))
    await onDone('Terms prepared and sent to the manager for approval.')
  }

  return (
    <Card
      title={draft ? 'Accountant — correct the returned terms' : 'Accountant — prepare loan terms'}
      hint="The rate is a per-loan decision. The manager approves these exact terms before the student sees them."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium">
          Tranche principal (TZS)
          <input
            className="input mt-1"
            inputMode="decimal"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className="block text-sm font-medium">
          Annual interest rate (%)
          <input
            className="input mt-1"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className="block text-sm font-medium">
          Repayment period
          <select className="input mt-1" value={months} onChange={(e) => setMonths(e.target.value)}>
            {periods.map((m) => (
              <option key={m} value={m}>
                {monthsLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block text-sm font-medium">
        Note for the manager (optional)
        <textarea
          className="input mt-1"
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
        />
      </label>

      {quote && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Installment <b><Money value={quote.installment_amount} /></b> a month for{' '}
            {monthsLabel(Number(months))}. Interest{' '}
            <Money value={quote.total_interest} />, total repayable{' '}
            <Money value={quote.total_repayable} />.
          </p>
        </div>
      )}
      {quoteError && <p className="mt-2 text-xs text-red-600">{quoteError}</p>}

      <button className="btn-primary mt-3" disabled={busy !== null} onClick={() => void submit()}>
        {busy === 'terms' ? 'Preparing…' : draft ? 'Update terms and resend' : 'Prepare terms for approval'}
      </button>
    </Card>
  )
}

// ---------------------------------------------------------------------------------------
// Accountant: disburse an accepted tranche.
// ---------------------------------------------------------------------------------------
function DisburseForm({
  terms,
  remaining,
  userId,
  busy,
  setBusy,
  onDone,
  onError,
}: {
  terms: Terms
  remaining: number
  userId: string
  busy: string | null
  setBusy: (v: string | null) => void
  onDone: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [channel, setChannel] = useState('MOBILE_MONEY')
  const [reference, setReference] = useState('')
  const [proof, setProof] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  const key = `disb-${terms.terms_id}`
  const needsReference = channel !== 'CASH'

  const submit = async () => {
    if (!proof) return onError('Attach proof of payment before recording this disbursement.')
    if (needsReference && reference.trim() === '')
      return onError('Enter the transaction reference for this payment.')
    if (!confirmed)
      return onError('Confirm that the money has actually been paid before recording this disbursement.')

    setBusy(key)
    try {
      const path = await uploadPaymentProof(userId, reference.trim() || terms.terms_id.slice(0, 8), proof)
      const { error } = await supabase.rpc('disburse_tranche', {
        p_terms_id: terms.terms_id,
        p_channel: channel,
        p_reference: reference.trim() || null,
        p_proof_path: path,
        p_idempotency_key: `${terms.terms_id}:${Date.now()}`,
        p_confirm: true,
      })
      if (error) {
        setBusy(null)
        return onError(describeError(error))
      }
      setBusy(null)
      setProof(null)
      setReference('')
      setConfirmed(false)
      await onDone(
        `Tranche ${terms.tranche_no} disbursed. The repayment schedule starts from today.`,
      )
    } catch (e) {
      setBusy(null)
      onError(describeError(e))
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-green-300 bg-green-50 p-3">
      <p className="text-sm font-medium text-green-900">
        Disburse tranche {terms.tranche_no} — <Money value={terms.principal_amount} />
      </p>
      <p className="mt-1 text-xs text-green-900">
        The student accepted these terms. Record the payment only after the money has actually left.
        {remaining > 0.01
          ? ` ${money(remaining)} of the requested amount remains outside this tranche.`
          : ''}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Channel
          <select className="input mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Transaction reference {needsReference ? '' : '(optional for cash)'}
          <input
            className="input mt-1"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={120}
          />
        </label>
      </div>

      <label className="mt-3 block text-sm font-medium">
        Proof of payment
        <input
          type="file"
          className="mt-1 block w-full text-xs"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          onChange={(e) => setProof(e.target.files?.[0] ?? null)}
        />
      </label>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>I confirm the money has actually been paid to the student.</span>
      </label>

      <button className="btn-primary mt-3" disabled={busy !== null} onClick={() => void submit()}>
        {busy === key ? 'Recording…' : 'Record disbursement'}
      </button>
    </div>
  )
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `TZS ${value.toLocaleString('en-TZ')}`
}
