import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../config/site'
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

type Approved = { id: string; application_number: string; amount: number }
type Loan = {
  id: string
  principal_amount: number
  outstanding_balance: number
  status: string
  disbursed_at: string
  /** Shape of PostgREST's embedded count: `loan_installments(count)` comes back as [{count}]. */
  loan_installments: { count: number }[] | null
}

export default function AdminLoans() {
  const { role } = useAuth()
  const canDisburse = hasPermission(role, 'loans.disburse')
  const canVoid = role === 'MANAGER' || role === 'SUPER_ADMIN'
  const canRecalculate = canVoid

  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const approved = useAdminList<Approved>(
    (from, to) =>
      supabase
        .from('loan_applications')
        .select('id,application_number,amount', { count: 'exact' })
        .eq('status', 'APPROVED')
        .order('submitted_at', { ascending: true })
        .range(from, to),
    PAGE_SIZE,
  )

  const loans = useAdminList<Loan>(
    (from, to) => {
      let query = supabase
        .from('loans')
        .select('id,application_id,principal_amount,outstanding_balance,status,disbursed_at,loan_installments(count)', {
          count: 'exact',
        })
      if (role === 'LOAN_OFFICER') query = query.eq('status', 'ACTIVE')
      return query.order('disbursed_at', { ascending: false }).range(from, to)
    },
    PAGE_SIZE,
  )

  /**
   * An inline amount field rather than window.prompt. The prompt accepted anything, and the
   * database would then refuse it with a message about a range — after the user had already typed
   * a loan number.
   */
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  const disburse = async (a: Approved) => {
    setActionError('')
    setNotice('')
    const raw = amounts[a.id] ?? String(a.amount)
    const value = Number(raw)

    if (!Number.isFinite(value) || value <= 0) {
      setActionError('Enter an amount greater than zero.')
      return
    }

    setBusy(a.id)
    const { error } = await supabase.rpc('disburse_loan', { p_application_id: a.id, p_amount: value })
    setBusy(null)

    if (error) {
      setActionError(describeError(error))
      return
    }
    setNotice(`Disbursed ${a.application_number}. A repayment schedule has been generated for it.`)
    setAmounts((prev) => ({ ...prev, [a.id]: '' }))
    approved.reload()
    loans.reload()
  }

  const voidDisbursement = async (loanId: string) => {
    setActionError('')
    setNotice('')
    const reason = askReason(
      'This DELETES the loan and returns the application to "Approved". Only possible if no payment has been taken against it.\n\nReason (kept in the audit log):',
    )
    if (reason === null) return

    setBusy(loanId)
    const { error } = await supabase.rpc('void_disbursement', { p_loan_id: loanId, p_reason: reason })
    setBusy(null)

    if (error) {
      setActionError(describeError(error))
      return
    }
    setNotice('Disbursement voided. The application is back in the queue for disbursement.')
    approved.reload()
    loans.reload()
  }

  const recalculate = async (loanId: string) => {
    setActionError('')
    setNotice('')
    if (!confirmAction('Recompute this loan\'s balance and installments from its recorded payments?')) return

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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Loans</h1>

      <ErrorNote error={actionError} />
      {notice && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      {canDisburse && <Card title="Approved — awaiting disbursement">
        <ErrorNote error={approved.error} onRetry={approved.reload} />
        {approved.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : approved.rows.length === 0 ? (
          <Empty>Nothing awaiting disbursement.</Empty>
        ) : (
          <>
            <ul className="space-y-2">
              {approved.rows.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm"
                >
                  {hasPermission(role, 'applications.view') ||
                  hasPermission(role, 'applications.disbursement_view') ? (
                    <Link className="font-mono text-xs underline" to={`/admin/applications/${a.id}`}>
                      {a.application_number} · Review approval and contract
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{a.application_number}</span>
                  )}
                  <span className="text-slate-600">
                    Approved <Money value={a.amount} />
                  </span>
                  {canDisburse && (
                    <div className="flex items-center gap-2">
                      <input
                        className="input w-36 py-1 text-sm"
                        inputMode="numeric"
                        value={amounts[a.id] ?? ''}
                        placeholder={String(a.amount)}
                        aria-label={`Disbursement amount for ${a.application_number}`}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [a.id]: e.target.value.replace(/[^\d]/g, '') }))
                        }
                      />
                      <button
                        className="btn-primary px-3 py-1 text-xs"
                        disabled={busy === a.id}
                        onClick={() => void disburse(a)}
                      >
                        {busy === a.id ? 'Disbursing…' : 'Disburse'}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">
              A partial disbursement is allowed and the loan is created for that amount.{' '}
              {approved.pageable && (
                <Pager
                  page={approved.page}
                  count={approved.count}
                  pageSize={PAGE_SIZE}
                  onPage={approved.setPage}
                />
              )}
            </p>
          </>
        )}
      </Card>}

      <Card title="Disbursed loans">
        <ErrorNote error={loans.error} onRetry={loans.reload} />
        {loans.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : loans.rows.length === 0 ? (
          <Empty>No loans disbursed yet.</Empty>
        ) : (
          <>
            <Table head={['Disbursed', 'Principal', 'Outstanding', 'Schedule', 'Status', '']}>
              {loans.rows.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
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
                    <Badge tone={STATUS_TONE[l.status]}>{l.status}</Badge>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1">
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
                      {canVoid && l.status !== 'CLOSED' && (
                        <button
                          className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                          disabled={busy === l.id}
                          onClick={() => void voidDisbursement(l.id)}
                        >
                          Void
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

      {!canVoid && (
        <p className="text-xs text-slate-400">
          Voiding a disbursement and recalculating a loan balance are restricted to managers and
          super admins. Both actions are logged.
        </p>
      )}
    </div>
  )
}