import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Money,
  Pager,
  STATUS_TONE,
  Table,
  askReason,
  confirmAction,
  date,
} from '../components/ui'

const PAGE_SIZE = 25

type Awaiting = { id: string; application_number: string | null; amount: number | null }
type Loan = {
  id: string
  application_id: string
  principal_amount: number
  outstanding_balance: number
  status: string
  disbursed_at: string
  loan_applications: { application_number: string | null } | null
  /** Shape of PostgREST's embedded count: `loan_installments(count)` comes back as [{count}]. */
  loan_installments: { count: number }[] | null
}

/**
 * The disbursement and loan files, after the workflow has done its part.
 *
 * Disbursement itself is NOT offered here any more. It requires an accepted set of terms, a payment
 * channel, a unique transaction reference and proof of payment, and it is recorded per tranche —
 * three of those things cannot be collected in a one-line inline form, and doing it here invited
 * the exact failure the workflow is meant to prevent: money recorded against terms the student had
 * not accepted. The button below therefore links to the application, where the accepted terms are
 * shown next to the form that records the payment.
 */
export default function AdminLoans() {
  const { role } = useAuth()
  const canVoid = role === 'MANAGER' || role === 'SUPER_ADMIN'
  const canRecalculate = canVoid
  const canClose = role === 'ACCOUNTANT' || role === 'SUPER_ADMIN'

  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const awaiting = useAdminList<Awaiting>(
    (from, to) =>
      supabase
        .from('loan_applications')
        .select('id,application_number,amount', { count: 'exact' })
        .eq('status', 'TERMS_ACCEPTED')
        .order('submitted_at', { ascending: true, nullsFirst: false })
        .range(from, to),
    PAGE_SIZE,
  )

  const loans = useAdminList<Loan>(
    (from, to) =>
      supabase
        .from('loans')
        .select(
          'id,application_id,principal_amount,outstanding_balance,status,disbursed_at,loan_applications(application_number),loan_installments(count)',
          { count: 'exact' },
        )
        .order('disbursed_at', { ascending: false })
        .range(from, to),
    PAGE_SIZE,
  )

  const voidDisbursement = async (loanId: string) => {
    setActionError('')
    setNotice('')
    const reason = askReason(
      'This voids the most recent tranche of this loan. Only possible if no live payment has been ' +
        'taken against the loan.\n\nReason (kept in the audit log):',
    )
    if (reason === null) return

    setBusy(loanId)
    const { error } = await supabase.rpc('void_disbursement', { p_loan_id: loanId, p_reason: reason })
    setBusy(null)

    if (error) {
      setActionError(describeError(error))
      return
    }
    setNotice('Disbursement voided. The terms and schedule for that tranche are voided with it.')
    awaiting.reload()
    loans.reload()
  }

  const recalculate = async (loanId: string) => {
    setActionError('')
    setNotice('')
    if (!confirmAction("Recompute this loan's balance and installments from its recorded payments?")) return

    setBusy(loanId)
    const { error } = await supabase.rpc('recalculate_loan', { p_loan_id: loanId })
    setBusy(null)

    if (error) {
      setActionError(describeError(error))
      return
    }
    setNotice('Loan recalculated from the repayments table.')
    loans.reload()
  }

  const closeLoan = async (loanId: string) => {
    setActionError('')
    setNotice('')
    const note = askReason(
      'Reconciliation note. Confirm every repayment is verified, the balance is settled and the ' +
        'file is complete.',
      5,
    )
    if (note === null) return
    if (!confirmAction('Close this loan? This is the final reconciliation and cannot be undone.')) return

    setBusy(loanId)
    const { error } = await supabase.rpc('close_loan', { p_loan_id: loanId, p_note: note })
    setBusy(null)
    if (error) {
      setActionError(describeError(error))
      return
    }
    setNotice('Loan closed and reconciled.')
    loans.reload()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Loans</h1>

      <ErrorNote error={actionError} />
      {notice && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      <Card
        title="Terms accepted — awaiting disbursement"
        hint="The student has read and accepted the terms. Record the payment on the application."
      >
        <ErrorNote error={awaiting.error} onRetry={awaiting.reload} />
        {awaiting.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : awaiting.rows.length === 0 ? (
          <Empty>Nothing awaiting disbursement.</Empty>
        ) : (
          <>
            <ul className="space-y-2">
              {awaiting.rows.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <Link className="font-mono text-xs underline" to={`/admin/applications/${a.id}`}>
                    {a.application_number ?? 'Application'}
                  </Link>
                  <span className="text-slate-600">
                    Accepted <Money value={a.amount} />
                  </span>
                  <Link className="btn-primary px-3 py-1 text-xs" to={`/admin/applications/${a.id}`}>
                    Open to disburse
                  </Link>
                </li>
              ))}
            </ul>
            {awaiting.pageable && (
              <Pager
                page={awaiting.page}
                count={awaiting.count}
                pageSize={PAGE_SIZE}
                onPage={awaiting.setPage}
              />
            )}
          </>
        )}
      </Card>

      <Card title="Loan files">
        <ErrorNote error={loans.error} onRetry={loans.reload} />
        {loans.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : loans.rows.length === 0 ? (
          <Empty>No loans disbursed yet.</Empty>
        ) : (
          <>
            <Table head={['App no.', 'Disbursed', 'Principal', 'Outstanding', 'Schedule', 'Status', '']}>
              {loans.rows.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">
                    <Link className="underline" to={`/admin/applications/${l.application_id}`}>
                      {l.loan_applications?.application_number ?? '—'}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{date(l.disbursed_at)}</td>
                  <td className="py-2 pr-3">
                    <Money value={l.principal_amount} />
                  </td>
                  <td className="py-2 pr-3">
                    <Money value={l.outstanding_balance} />
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {(l.loan_installments?.[0]?.count ?? 0) > 0 ? (
                      <span className="text-green-700">{l.loan_installments![0].count} installments</span>
                    ) : (
                      <span
                        className="text-amber-700"
                        title="Loans created before migration 013 have no schedule. verify_migrations.sql section 12 lists them."
                      >
                        none
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATUS_TONE[l.status] ?? 'slate'}>{l.status}</Badge>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {canClose && l.status === 'PAID_OFF' && (
                        <button
                          className="btn-primary px-2 py-1 text-xs"
                          disabled={busy === l.id}
                          onClick={() => void closeLoan(l.id)}
                        >
                          {busy === l.id ? 'Closing…' : 'Close'}
                        </button>
                      )}
                      {canRecalculate && (
                        <button
                          className="btn-outline px-2 py-1 text-xs"
                          disabled={busy === l.id}
                          title="Recompute this loan from the repayments table"
                          onClick={() => void recalculate(l.id)}
                        >
                          Recalculate
                        </button>
                      )}
                      {canVoid && l.status !== 'CLOSED' && l.status !== 'VOIDED' && (
                        <button
                          className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                          disabled={busy === l.id}
                          onClick={() => void voidDisbursement(l.id)}
                        >
                          Void tranche
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
            <Pager page={loans.page} count={loans.count} pageSize={PAGE_SIZE} onPage={loans.setPage} />
          </>
        )}
      </Card>

      <p className="text-xs text-slate-400">
        Disbursement is recorded on the application, against accepted terms. Voiding a tranche is
        restricted to managers and super admins; final reconciliation is the accountant's. Every
        action is logged.
      </p>
    </div>
  )
}
