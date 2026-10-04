import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeError, rpc } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { Badge, Card, Empty, ErrorNote, Money, Table, askReason, date } from '../components/ui'

type Row = {
  loan_id: string
  student_name: string
  university: string
  outstanding: number
  due_date: string
  days_overdue: number
  installments_missed: number
  total_due: number
  amount_paid: number
}

/**
 * list_arrears() is no longer a single due date at the end of the term. Migration 013 generates one
 * installment per month, so a loan falls into arrears from its first missed month, and the counts
 * below are real: how many installments are unpaid, how far behind the oldest one is, and how much
 * of the schedule has been met.
 */
export default function AdminCollections() {
  const { role } = useAuth()
  const canDefault = role !== 'LOAN_OFFICER' && role !== 'MARKETING_OFFICER'

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await rpc<Row>('list_arrears')
      setRows(data)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const remind = async (loanId: string) => {
    setNotice('')
    const channel = window.prompt('Channel (SMS / EMAIL / CALL / VISIT):', 'SMS')
    if (channel === null) return

    setBusy(loanId)
    const { error: e } = await supabase.rpc('log_reminder', {
      p_loan_id: loanId,
      p_channel: channel.trim().toUpperCase(),
    })
    setBusy(null)
    if (e) {
      setError(describeError(e))
      return
    }
    setNotice(
      `Reminder logged (${channel.trim().toUpperCase()}). Note: no SMS or email provider is configured yet, so this records that contact was ATTEMPTED — it did not message the student.`,
    )
  }

  const markDefaulted = async (loanId: string) => {
    setNotice('')
    const reason = askReason('Reason for flagging this loan as defaulted (kept in the audit log):')
    if (reason === null) return

    setBusy(loanId)
    const { error: e } = await supabase.rpc('mark_loan_defaulted', { p_loan_id: loanId, p_reason: reason })
    setBusy(null)
    if (e) {
      setError(describeError(e))
      return
    }
    setNotice('Loan flagged as defaulted. It stays out of the active-loan count but keeps accruing arrears.')
    await load()
  }

  const total = rows.reduce((s, r) => s + Number(r.outstanding), 0)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Collections</h1>

      <ErrorNote error={error} onRetry={() => void load()} />
      {notice && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{notice}</p>}

      <Card
        title="Loans in arrears"
        hint="Arrears start at the first missed installment, not at a single end-of-term date. The oldest unpaid installment's date drives days overdue."
        actions={
          <span className="text-sm text-slate-600">
            {rows.length} loan{rows.length === 1 ? '' : 's'} · <Money value={total} /> overdue
          </span>
        }
      >
        {loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : rows.length === 0 ? (
          <Empty>No loans in arrears.</Empty>
        ) : (
          <Table
            head={['Student', 'University', 'Missed', 'Oldest due', 'Overdue by', 'Outstanding', 'Repaid', '']}
          >
            {rows.map((r) => (
              <tr key={r.loan_id} className="border-b last:border-0">
                <td className="py-2 pr-3">{r.student_name}</td>
                <td className="py-2 pr-3">{r.university}</td>
                <td className="py-2 pr-3 text-xs">
                  {r.installments_missed} installment{r.installments_missed === 1 ? '' : 's'}
                </td>
                <td className="py-2 pr-3 text-xs">{date(r.due_date)}</td>
                <td className="py-2 pr-3">
                  <Badge tone={Number(r.days_overdue) > 30 ? 'red' : 'amber'}>{r.days_overdue}d</Badge>
                </td>
                <td className="py-2 pr-3">
                  <Money value={r.outstanding} />
                </td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  <Money value={r.amount_paid} /> of <Money value={r.total_due} />
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    <button
                      className="btn-outline px-2 py-1 text-xs"
                      disabled={busy === r.loan_id}
                      onClick={() => void remind(r.loan_id)}
                    >
                      Log reminder
                    </button>
                    {canDefault && (
                      <button
                        className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                        disabled={busy === r.loan_id}
                        onClick={() => void markDefaulted(r.loan_id)}
                      >
                        Flag default
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}