import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError, tzs } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Money,
  Table,
  askReason,
  dateTime,
} from '../components/ui'

type Loan = { id: string; outstanding_balance: number }
type Repayment = {
  id: string
  amount: number
  method: string
  reference: string | null
  paid_at: string
  recorded_by: string | null
  reversed_at: string | null
  reversal_reason: string | null
}

const METHODS: [string, string][] = [
  ['CASH', 'Cash'],
  ['MOBILE_MONEY', 'Mobile Money'],
  ['BANK_TRANSFER', 'Bank Transfer'],
]

export default function AdminRepayments() {
  const { role, session } = useAuth()
  const canReverse = role === 'MANAGER' || role === 'SUPER_ADMIN'

  const loans = useAdminList<Loan>(
    (from, to) =>
      supabase
        .from('loans')
        .select('id,outstanding_balance', { count: 'exact' })
        .eq('status', 'ACTIVE')
        .order('outstanding_balance', { ascending: false })
        .range(from, to),
    100,
  )

  const [loanId, setLoanId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Repayment[]>([])

  const selected = loans.rows.find((l) => l.id === loanId) ?? null
  const remaining = Number(selected?.outstanding_balance ?? 0)

  const loadHistory = useCallback(async (id: string) => {
    if (!id) {
      setHistory([])
      return
    }
    try {
      const { data, error } = await supabase
        .from('repayments')
        .select('id,amount,method,reference,paid_at,recorded_by,reversed_at,reversal_reason')
        .eq('loan_id', id)
        .order('paid_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      setHistory((data ?? []) as Repayment[])
    } catch (e) {
      setError(describeError(e))
    }
  }, [])

  useEffect(() => {
    void loadHistory(loanId)
  }, [loanId, loadHistory])

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    setMsg('')
    setError('')

    const value = Number(amount)
    if (!loanId) return setError('Select a loan first.')
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.')
    if (value > remaining) {
      // The database refuses this too, but saying it here saves a round trip and a confusing
      // Postgres message about "remaining scheduled amount".
      return setError(
        `That is more than the ${tzs(remaining)} still scheduled on this loan. Split the payment if this is not a mistake.`,
      )
    }

    setBusy(true)
    const { error: e } = await supabase.rpc('record_repayment', {
      p_loan_id: loanId,
      p_amount: value,
      p_method: method,
      p_reference: reference.trim() || null,
    })
    setBusy(false)

    if (e) {
      setError(describeError(e))
      return
    }
    setMsg(`Repayment of ${tzs(value)} recorded and allocated to the oldest unpaid installments.`)
    setAmount('')
    setReference('')
    loans.reload()
    await loadHistory(loanId)
  }

  const reverse = async (id: string) => {
    setError('')
    const reason = askReason(
      'This reverses the repayment. The entry is kept and marked as reversed, and the loan balance is recalculated.\n\nReason (kept in the audit log):',
    )
    if (reason === null) return

    setBusy(true)
    const { error: e } = await supabase.rpc('reverse_repayment', { p_repayment_id: id, p_reason: reason })
    setBusy(false)

    if (e) {
      setError(describeError(e))
      return
    }
    setMsg('Repayment reversed.')
    loans.reload()
    await loadHistory(loanId)
  }

  const needsReference = method === 'MOBILE_MONEY' || method === 'BANK_TRANSFER'

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Repayments</h1>

      <ErrorNote error={error || loans.error} onRetry={loans.reload} />
      {msg && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{msg}</p>}

      <Card
        title="Record a repayment"
        hint="Payments are allocated to the oldest unpaid installment first, then the loan balance and status are recalculated from the repayments table."
      >
        {loans.loading ? (
          <p className="text-slate-500">Loading active loans…</p>
        ) : loans.rows.length === 0 ? (
          <Empty>No active loans to collect against.</Empty>
        ) : (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
            <label className="block text-sm font-medium sm:col-span-2">
              Loan
              <select
                className="input mt-1"
                value={loanId}
                onChange={(e) => {
                  setLoanId(e.target.value)
                  setAmount('')
                }}
              >
                <option value="">Select an active loan</option>
                {loans.rows.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.id.slice(0, 8)} — outstanding {tzs(l.outstanding_balance)}
                  </option>
                ))}
              </select>
            </label>

            {selected && (
              <p className="sm:col-span-2 text-xs text-slate-500">
                Scheduled outstanding on this loan: <b>{tzs(remaining)}</b>. Nothing beyond that can be
                allocated.
              </p>
            )}

            <label className="block text-sm font-medium">
              Amount (TZS)
              <span className="mt-1 flex gap-2">
                <input
                  className="input"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                />
                <button
                  type="button"
                  className="btn-outline shrink-0 px-3 text-xs"
                  disabled={!remaining}
                  onClick={() => setAmount(String(remaining))}
                >
                  Max
                </button>
              </span>
            </label>

            <label className="block text-sm font-medium">
              Method
              <select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm font-medium sm:col-span-2">
              Reference{' '}
              <span className="text-xs font-normal text-slate-500">
                {needsReference
                  ? '(required in practice — a mobile-money or bank reference can only be used once)'
                  : '(optional, and not enforced for cash)'}
              </span>
              <input
                className="input mt-1"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={120}
              />
            </label>

            <button className="btn-primary sm:col-span-2" disabled={busy}>
              {busy ? 'Recording…' : 'Record repayment'}
            </button>
          </form>
        )}
      </Card>

      {loanId && (
        <Card title="This loan's repayment history" hint="Reversed entries are kept and shown struck through, not deleted.">
          {history.length === 0 ? (
            <Empty>No repayments recorded against this loan yet.</Empty>
          ) : (
            <Table head={['Recorded', 'Amount', 'Method', 'Reference', 'By', '']}>
              {history.map((r) => (
                <tr key={r.id} className={`border-b last:border-0 ${r.reversed_at ? 'opacity-60' : ''}`}>
                  <td className="py-2 pr-3 text-xs text-slate-500">{dateTime(r.paid_at)}</td>
                  <td className={`py-2 pr-3 ${r.reversed_at ? 'line-through' : ''}`}>
                    <Money value={r.amount} />
                  </td>
                  <td className="py-2 pr-3 text-xs">{r.method.replace('_', ' ')}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.reference ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {r.recorded_by ?? '—'}
                    {r.recorded_by === session?.user.id ? ' (you)' : ''}
                  </td>
                  <td className="py-2 pr-3">
                    {r.reversed_at ? (
                      <span className="text-xs text-slate-500">
                        Reversed{r.reversal_reason ? `: ${r.reversal_reason}` : ''}
                      </span>
                    ) : canReverse ? (
                      <button
                        className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                        disabled={busy}
                        onClick={() => void reverse(r.id)}
                      >
                        Reverse
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {canReverse && (
        <p className="text-xs text-slate-400">
          Reversals are for managers and super admins, and you cannot reverse a payment you recorded
          yourself — <Badge tone="slate">ask another manager</Badge>.
        </p>
      )}
    </div>
  )
}