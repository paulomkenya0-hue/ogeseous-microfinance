import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc, tzs } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Money, Table, date, dateTime } from '../components/ui'

type Loan = {
  id: string
  principal_amount: number
  outstanding_balance: number
  status: string
  disbursed_at: string
}
type Installment = {
  seq: number
  due_date: string
  amount_due: number
  amount_paid: number
  amount_outstanding: number
  status: string
  days_overdue: number
}
type Repayment = {
  id: string
  amount: number
  method: string
  reference: string | null
  paid_at: string
  reversed_at: string | null
  reversal_reason: string | null
}

/**
 * The student-facing view of the loan.
 *
 * Migration 013 replaced the single end-of-term due date with a monthly schedule. This page shows
 * it: what is due next, what is already behind, and the full repayment history with any reversal
 * visible rather than quietly removed.
 */
export default function StudentLoan() {
  const { session } = useAuth()
  const [loan, setLoan] = useState<Loan | null>(null)
  const [schedule, setSchedule] = useState<Installment[]>([])
  const [history, setHistory] = useState<Repayment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const { data: loanRow, error: e } = await supabase
        .from('loans')
        .select('id,principal_amount,outstanding_balance,status,disbursed_at')
        .eq('user_id', session.user.id)
        .order('disbursed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (e) throw new Error(e.message)
      setLoan(loanRow as Loan | null)
      if (!loanRow) {
        setLoading(false)
        return
      }

      // The schedule comes from an RPC rather than a direct read so this page keeps working if the
      // RLS policy on loan_installments is ever tightened further.
      const [sched, reps] = await Promise.all([
        rpc<Installment>('get_loan_schedule', { p_loan_id: loanRow.id }),
        supabase
          .from('repayments')
          .select('id,amount,method,reference,paid_at,reversed_at,reversal_reason')
          .eq('loan_id', loanRow.id)
          .order('paid_at', { ascending: false })
          .limit(100),
      ])
      if (reps.error) throw new Error(reps.error.message)

      setSchedule(sched)
      setHistory((reps.data ?? []) as Repayment[])
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">We could not load your loan</h1>
          <ErrorNote error={error} onRetry={() => void load()} />
        </div>
      </div>
    )
  }

  if (!loan) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">My Loan</h1>
          <p className="mt-2 text-slate-600">You do not have a disbursed loan yet.</p>
        </div>
      </div>
    )
  }

  const next = schedule.find((i) => Number(i.amount_outstanding) > 0) ?? null
  const overdue = schedule.filter((i) => Number(i.amount_outstanding) > 0 && i.days_overdue > 0)
  const paidOff = Number(loan.outstanding_balance) === 0

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold text-navy">My Loan</h1>

      <div className="card grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-xs text-slate-500">Principal</p>
          <p className="text-lg font-semibold">
            <Money value={loan.principal_amount} />
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Outstanding</p>
          <p className={`text-lg font-semibold ${paidOff ? 'text-green-700' : 'text-accent'}`}>
            <Money value={loan.outstanding_balance} />
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Status</p>
          <p className="text-lg font-semibold">{loan.status.replace('_', ' ')}</p>
        </div>
      </div>

      {overdue.length > 0 && (
        <div className="card border-red-200 bg-red-50">
          <h2 className="font-semibold text-red-700">
            {overdue.length} payment{overdue.length === 1 ? '' : 's'} behind
          </h2>
          <p className="mt-1 text-sm text-red-700">
            The oldest missed payment was due {date(overdue[0].due_date)}, {overdue[0].days_overdue}{' '}
            day{overdue[0].days_overdue === 1 ? '' : 's'} ago. <Money value={overdue[0].amount_outstanding} /> is
            outstanding on it. Please contact OGESEOUS to agree a way forward.
          </p>
        </div>
      )}

      {schedule.length === 0 ? (
        <Card title="Repayment schedule">
          <Empty>
            This loan has no installment schedule. Loans disbursed before the schedule feature was
            added are still valid — contact OGESEOUS to agree your payment dates.
          </Empty>
        </Card>
      ) : (
        <Card
          title="Repayment schedule"
          hint={
            next
              ? `Next payment: ${tzs(next.amount_due)} due ${date(next.due_date)}`
              : 'Every installment has been paid.'
          }
        >
          <Table head={['#', 'Due', 'Amount', 'Paid', 'Outstanding']}>
            {schedule.map((i) => (
              <tr key={i.seq} className="border-b last:border-0">
                <td className="py-2 pr-3 text-xs text-slate-500">{i.seq}</td>
                <td className="py-2 pr-3 text-xs">
                  {date(i.due_date)}
                  {i.days_overdue > 0 && Number(i.amount_outstanding) > 0 && (
                    <Badge tone="red">{i.days_overdue}d late</Badge>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <Money value={i.amount_due} />
                </td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  <Money value={i.amount_paid} />
                </td>
                <td className="py-2 pr-3">
                  {Number(i.amount_outstanding) > 0 ? (
                    <b>
                      <Money value={i.amount_outstanding} />
                    </b>
                  ) : (
                    <span className="text-green-700">Paid</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Repayment history" hint="Entries corrected by staff are shown here with the reason, not deleted.">
        {history.length === 0 ? (
          <Empty>No repayments recorded yet.</Empty>
        ) : (
          <Table head={['Date', 'Amount', 'Method', 'Reference']}>
            {history.map((r) => (
              <tr key={r.id} className={`border-b last:border-0 ${r.reversed_at ? 'opacity-60' : ''}`}>
                <td className="py-2 pr-3 text-xs">{dateTime(r.paid_at)}</td>
                <td className={`py-2 pr-3 ${r.reversed_at ? 'line-through' : ''}`}>
                  <Money value={r.amount} />
                </td>
                <td className="py-2 pr-3 text-xs">{r.method.replace('_', ' ')}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  {r.reference ?? '—'}
                  {r.reversed_at && (
                    <Badge tone="red">Reversed{r.reversal_reason ? `: ${r.reversal_reason}` : ''}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-xs text-slate-400">
        Disbursed {date(loan.disbursed_at)}. If a figure here looks wrong, contact OGESEOUS before
        paying against it — payments are applied to the oldest unpaid installment first.
      </p>
    </div>
  )
}