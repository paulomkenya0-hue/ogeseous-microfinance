import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
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

type LoanSearchRow = {
  loan_id: string
  full_name: string | null
  phone: string | null
  application_number: string | null
  outstanding_balance: number
  disbursed_at: string
}

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

  // Server-side loan search: matches loan ID prefix, application number, student name or
  // phone. Replaces the old "first 100 active loans" dropdown that could not reach loan
  // #101 through the UI. Results are capped at 25 by the function.
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LoanSearchRow[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  const runSearch = useCallback(async (q: string) => {
    setSearching(true)
    setSearchError('')
    try {
      const { data, error } = await supabase.rpc('search_active_loans', { p_query: q })
      if (error) throw new Error(error.message)
      setResults((data ?? []) as LoanSearchRow[])
    } catch (e) {
      setSearchError(describeError(e))
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300)
    return () => clearTimeout(t)
  }, [query, runSearch])

  const [loanId, setLoanId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Repayment[]>([])

  // Snapshot of the chosen loan so it survives a search refresh (e.g. the result list no
  // longer contains it because the repayment just closed it out).
  const [selected, setSelected] = useState<LoanSearchRow | null>(null)
  // Prefer the live search row (fresh outstanding after a payment); fall back to the snapshot
  // so the panel stays populated even if the loan dropped out of the current search results.
  const current = results.find((l) => l.loan_id === loanId) ?? selected
  const remaining = Number(current?.outstanding_balance ?? 0)

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
    void runSearch(query)
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
    void runSearch(query)
    await loadHistory(loanId)
  }

  const needsReference = method === 'MOBILE_MONEY' || method === 'BANK_TRANSFER'

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Repayments</h1>

      <ErrorNote error={error || searchError} onRetry={() => void runSearch(query)} />
      {msg && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{msg}</p>}

      <Card
        title="Record a repayment"
        hint="Payments are allocated to the oldest unpaid installment first, then the loan balance and status are recalculated from the repayments table."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium sm:col-span-2">
            Find a loan
            <input
              className="input mt-1"
              placeholder="Student name, phone, application number or loan ID…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          {searching && <p className="text-sm text-slate-500">Searching…</p>}
          {!searching && results.length === 0 && (
            <Empty>
              {query.trim() === ''
                ? 'No active loans yet.'
                : 'No active loans match that search.'}
            </Empty>
          )}

          {results.length > 0 && (
            <ul className="sm:col-span-2 divide-y rounded-lg border">
              {results.map((l) => (
                <li key={l.loan_id}>
                  <button
                    type="button"
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                      loanId === l.loan_id ? 'bg-navy/5 font-medium' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => {
                      setLoanId(l.loan_id)
                      setSelected(l)
                      setAmount('')
                    }}
                  >
                    <span>
                      {l.full_name ?? 'Unnamed'} · {l.phone ?? 'no phone'}
                    </span>
                    <span className="text-xs text-slate-500">
                      {l.application_number ?? l.loan_id.slice(0, 8)} — outstanding{' '}
                      {tzs(l.outstanding_balance)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {current && (
            <p className="sm:col-span-2 text-xs text-slate-500">
              Selected loan {current.loan_id.slice(0, 8)} ({current.full_name ?? 'unnamed'}) —
              scheduled outstanding: <b>{tzs(remaining)}</b>. Nothing beyond that can be allocated.
            </p>
          )}
        </div>

        {current && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 mt-3" noValidate>
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