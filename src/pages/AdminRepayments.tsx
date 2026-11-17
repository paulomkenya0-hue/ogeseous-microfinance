import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError, rpc, rpcOne, tzs } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { openPaymentProof, uploadPaymentProof } from '../lib/storage'
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Money,
  STATUS_TONE,
  Table,
  askReason,
  confirmAction,
  dateTime,
} from '../components/ui'
import { REPAYMENT_STATUS_LABEL } from '../lib/application'

type Loan = {
  id: string
  outstanding_balance: number
  status: string
  loan_applications: { application_number: string | null } | null
}
type PendingRepayment = {
  repayment_id: string
  loan_id: string
  application_id: string
  application_number: string | null
  student_name: string | null
  amount: number
  method: string
  reference: string | null
  proof_path: string | null
  submitted_by: string | null
  submitted_by_name: string | null
  submitted_at: string
  tranche_no: number | null
  is_settlement: boolean
  waived_interest: number | null
}
type HistoryRepayment = {
  id: string
  amount: number
  method: string
  reference: string | null
  paid_at: string
  status: string
  submitted_by: string | null
  verified_by: string | null
  verification_note: string | null
  is_settlement: boolean
  reversed_at: string | null
  reversal_reason: string | null
}
type Quote = {
  loan_id: string
  principal_outstanding: number
  accrued_interest: number
  settlement_amount: number
  scheduled_outstanding: number
  as_of: string
}

const METHODS: [string, string][] = [
  ['CASH', 'Cash'],
  ['MOBILE_MONEY', 'Mobile Money'],
  ['BANK_TRANSFER', 'Bank Transfer'],
]

const needsReference = (method: string) => method !== 'CASH'

/**
 * Repayments are a two-person operation now.
 *
 * The officer who took the money submits the entry with a reference and (for anything but cash)
 * proof of payment. A DIFFERENT officer — accountant, manager or super admin — checks it against
 * the cash or bank record and verifies it; only then is it allocated to the schedule and counted in
 * the loan balance. The database enforces the separation of duties, so neither queue below will
 * offer a verify button for an entry the signed-in user submitted.
 */
export default function AdminRepayments() {
  const { role, session } = useAuth()
  const uid = session?.user.id ?? ''
  const canVerify = role === 'ACCOUNTANT' || role === 'MANAGER' || role === 'SUPER_ADMIN'
  const canReverse = canVerify

  const [pending, setPending] = useState<PendingRepayment[]>([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [pendingError, setPendingError] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})

  const loans = useAdminList<Loan>(
    (from, to) =>
      supabase
        .from('loans')
        .select('id,outstanding_balance,status,loan_applications(application_number)', { count: 'exact' })
        .in('status', ['ACTIVE', 'DEFAULTED'])
        .order('outstanding_balance', { ascending: false })
        .range(from, to),
    100,
  )

  const [loanId, setLoanId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [proof, setProof] = useState<File | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryRepayment[]>([])
  const [amendFor, setAmendFor] = useState('')
  const [amendAmount, setAmendAmount] = useState('')
  const [amendReason, setAmendReason] = useState('')

  const [quote, setQuote] = useState<Quote | null>(null)
  const [settleMethod, setSettleMethod] = useState('MOBILE_MONEY')
  const [settleReference, setSettleReference] = useState('')
  const [settleProof, setSettleProof] = useState<File | null>(null)

  const selected = loans.rows.find((l) => l.id === loanId) ?? null
  const scheduled = Number(selected?.outstanding_balance ?? 0)
  const pendingOnLoan = pending
    .filter((p) => p.loan_id === loanId)
    .reduce((sum, p) => sum + Number(p.amount), 0)
  const available = Math.max(0, Math.round((scheduled - pendingOnLoan) * 100) / 100)

  const loadPending = useCallback(async () => {
    setPendingLoading(true)
    setPendingError('')
    try {
      const rows = await rpc<PendingRepayment>('list_pending_repayments')
      setPending(rows)
    } catch (e) {
      setPendingError(describeError(e))
    } finally {
      setPendingLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    if (!id) {
      setHistory([])
      return
    }
    try {
      const { data, error: e } = await supabase
        .from('repayments')
        .select(
          'id,amount,method,reference,paid_at,status,submitted_by,verified_by,verification_note,is_settlement,reversed_at,reversal_reason',
        )
        .eq('loan_id', id)
        .order('paid_at', { ascending: false })
        .limit(50)
      if (e) throw new Error(e.message)
      setHistory((data ?? []) as HistoryRepayment[])
    } catch (e) {
      setError(describeError(e))
    }
  }, [])

  useEffect(() => {
    void loadPending()
  }, [loadPending])

  useEffect(() => {
    void loadHistory(loanId)
  }, [loanId, loadHistory])

  // The settlement quote is only meaningful for an active loan with no payment already waiting.
  useEffect(() => {
    setQuote(null)
    if (!loanId || pendingOnLoan > 0) return
    let active = true
    rpcOne<Quote>('loan_settlement_quote', { p_loan_id: loanId })
      .then((q) => {
        if (active) setQuote(q)
      })
      .catch(() => {
        // Not an error worth showing: a legacy loan may simply have no quote until it is rebuilt.
        if (active) setQuote(null)
      })
    return () => {
      active = false
    }
  }, [loanId, pendingOnLoan])

  const resetForm = () => {
    setAmount('')
    setReference('')
    setProof(null)
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    setMsg('')
    setError('')

    const value = Number(amount)
    if (!loanId) return setError('Select a loan first.')
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.')
    if (value > available) {
      return setError(
        `That is more than the ${tzs(available)} still available on this loan after payments already awaiting verification.`,
      )
    }
    if (needsReference(method) && reference.trim() === '')
      return setError('Enter the transaction reference for this payment.')
    if (needsReference(method) && !proof)
      return setError('Attach proof of payment for a mobile-money or bank payment.')
    if (!uid) return setError('Your session has expired. Sign in again.')

    setBusy('submit')
    try {
      const proofPath = proof ? await uploadPaymentProof(uid, reference.trim() || 'repayment', proof) : null
      const { error: e } = await supabase.rpc('submit_repayment', {
        p_loan_id: loanId,
        p_amount: value,
        p_method: method,
        p_reference: reference.trim() || null,
        p_proof_path: proofPath,
        p_idempotency_key: `rep-${loanId}-${Date.now()}`,
      })
      if (e) {
        setBusy(null)
        return setError(describeError(e))
      }
      setBusy(null)
      setMsg(
        `Repayment of ${tzs(value)} submitted. It will not affect the balance until a different officer verifies it.`,
      )
      resetForm()
      loans.reload()
      await Promise.all([loadPending(), loadHistory(loanId)])
    } catch (e) {
      setBusy(null)
      setError(describeError(e))
    }
  }

  const submitSettlement = async () => {
    setMsg('')
    setError('')
    if (!loanId || !quote) return setError('Wait for the settlement quote, or select a loan that can be settled.')
    if (needsReference(settleMethod) && settleReference.trim() === '')
      return setError('Enter the transaction reference for this settlement.')
    if (needsReference(settleMethod) && !settleProof)
      return setError('Attach proof of payment for a mobile-money or bank settlement.')
    if (!uid) return setError('Your session has expired. Sign in again.')

    setBusy('settle')
    try {
      const proofPath = settleProof
        ? await uploadPaymentProof(uid, settleReference.trim() || 'settlement', settleProof)
        : null
      const { error: e } = await supabase.rpc('submit_loan_settlement', {
        p_loan_id: loanId,
        p_method: settleMethod,
        p_reference: settleReference.trim() || null,
        p_proof_path: proofPath,
        p_idempotency_key: `settle-${loanId}-${Date.now()}`,
      })
      if (e) {
        setBusy(null)
        return setError(describeError(e))
      }
      setBusy(null)
      setSettleReference('')
      setSettleProof(null)
      setMsg(
        `Settlement of ${tzs(Number(quote.settlement_amount))} submitted. A different officer must verify it before the loan is marked paid off.`,
      )
      loans.reload()
      await Promise.all([loadPending(), loadHistory(loanId)])
    } catch (e) {
      setBusy(null)
      setError(describeError(e))
    }
  }

  const verify = async (r: PendingRepayment) => {
    setError('')
    setMsg('')
    if (
      !confirmAction(
        `Verify ${tzs(Number(r.amount))} from ${r.student_name ?? 'the student'}? Confirm you have matched it ` +
          'against the cash or bank record. This allocates it to the schedule.',
      )
    )
      return
    setBusy(`verify-${r.repayment_id}`)
    const { error: e } = await supabase.rpc('verify_repayment', {
      p_repayment_id: r.repayment_id,
      p_comment: notes[r.repayment_id]?.trim() || null,
      p_confirm: true,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setMsg('Repayment verified and allocated to the schedule.')
    setNotes((prev) => {
      const next = { ...prev }
      delete next[r.repayment_id]
      return next
    })
    if (r.loan_id === loanId) {
      loans.reload()
      await loadHistory(loanId)
    }
    await loadPending()
  }

  const reject = async (r: PendingRepayment) => {
    setError('')
    setMsg('')
    const reason = askReason('Why is this repayment being rejected? The officer who submitted it is shown this.', 3)
    if (reason === null) return
    setBusy(`reject-${r.repayment_id}`)
    const { error: e } = await supabase.rpc('reject_repayment', {
      p_repayment_id: r.repayment_id,
      p_reason: reason,
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setMsg('Repayment rejected. It is excluded from the loan balance.')
    await loadPending()
    if (r.loan_id === loanId) await loadHistory(loanId)
  }

  const reverse = async (id: string) => {
    setError('')
    setMsg('')
    const reason = askReason(
      'This reverses the repayment. The entry is kept, marked as reversed, and the schedule is rebuilt.\n\nReason (kept in the audit log):',
      3,
    )
    if (reason === null) return

    setBusy(`reverse-${id}`)
    const { error: e } = await supabase.rpc('reverse_repayment', { p_repayment_id: id, p_reason: reason })
    setBusy(null)

    if (e) return setError(describeError(e))
    setMsg('Repayment reversed.')
    loans.reload()
    await loadHistory(loanId)
  }

  /**
   * The only way to change an amount after verification. The RPC requires a full reason and writes
   * the before/after snapshots to the immutable financial audit trail, so this is an audited
   * correction rather than a silent edit. It is offered to SUPER_ADMIN only.
   */
  const amend = async (r: HistoryRepayment) => {
    const amount = Number(amendAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter a corrected amount greater than zero.')
      return
    }
    if (amendReason.trim().length < 5) {
      setError('Give a full reason for the amendment — it is kept in the audit trail.')
      return
    }
    if (!confirmAction('Amend this verified repayment? The old and new amounts are both kept in the audit trail.')) return

    setBusy(`amend-${r.id}`)
    const { error: e } = await supabase.rpc('super_admin_amend_repayment', {
      p_repayment_id: r.id,
      p_amount: amount,
      p_reason: amendReason.trim(),
    })
    setBusy(null)
    if (e) return setError(describeError(e))
    setAmendFor('')
    setAmendAmount('')
    setAmendReason('')
    setMsg('Repayment amended and recorded in the financial audit trail.')
    loans.reload()
    await loadHistory(loanId)
  }

  const showProof = async (path: string) => {
    setError('')
    try {
      await openPaymentProof(path)
    } catch (e) {
      setError(describeError(e))
    }
  }

  /** A different officer must decide every entry, including a super admin's own. */
  const ownEntry = (r: PendingRepayment) => r.submitted_by === uid

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Repayments</h1>

      <ErrorNote error={error || loans.error} onRetry={loans.reload} />
      {msg && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{msg}</p>}

      <Card
        title="Awaiting verification"
        hint="Submitted by a collection officer or accountant. A different officer checks it against the cash or bank record before it counts."
        actions={canVerify ? <Badge tone="amber">{pending.length} waiting</Badge> : undefined}
      >
        <ErrorNote error={pendingError} onRetry={() => void loadPending()} />
        {pendingLoading ? (
          <p className="text-slate-500">Loading…</p>
        ) : pending.length === 0 ? (
          <Empty>Nothing is waiting for verification.</Empty>
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.repayment_id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-navy">
                      {r.student_name ?? 'Student'} · <span className="font-mono text-xs">{r.application_number ?? '—'}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {dateTime(r.submitted_at)} · submitted by {r.submitted_by_name ?? 'unknown'}
                      {r.tranche_no !== null ? ` · tranche ${r.tranche_no}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">
                      <Money value={r.amount} />
                    </p>
                    <p className="text-xs text-slate-500">
                      {r.method.replace('_', ' ').toLowerCase()}
                      {r.reference ? ` · ${r.reference}` : ''}
                    </p>
                    {r.is_settlement && (
                      <Badge tone="blue">
                        Settlement
                        {Number(r.waived_interest ?? 0) > 0
                          ? ` · ${tzs(Number(r.waived_interest))} interest waived`
                          : ''}
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {r.proof_path && (
                    <button
                      className="btn-outline px-2 py-1 text-xs"
                      onClick={() => void showProof(r.proof_path!)}
                    >
                      View proof
                    </button>
                  )}
                  {ownEntry(r) ? (
                    <span className="text-xs text-amber-700">
                      You submitted this payment. A different officer must verify or reject it.
                    </span>
                  ) : canVerify ? (
                    <>
                      <input
                        className="input w-56 py-1 text-xs"
                        placeholder="Verification note (optional)"
                        value={notes[r.repayment_id] ?? ''}
                        maxLength={300}
                        onChange={(e) =>
                          setNotes((prev) => ({ ...prev, [r.repayment_id]: e.target.value }))
                        }
                      />
                      <button
                        className="btn-primary px-2 py-1 text-xs"
                        disabled={busy !== null}
                        onClick={() => void verify(r)}
                      >
                        {busy === `verify-${r.repayment_id}` ? 'Verifying…' : 'Verify'}
                      </button>
                      <button
                        className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                        disabled={busy !== null}
                        onClick={() => void reject(r)}
                      >
                        {busy === `reject-${r.repayment_id}` ? 'Rejecting…' : 'Reject'}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">
                      Waiting for an accountant, manager or super admin.
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Submit a repayment"
        hint="This does not change the balance yet. A different officer must verify it first."
      >
        {loans.loading ? (
          <p className="text-slate-500">Loading active and defaulted loans…</p>
        ) : loans.rows.length === 0 ? (
          <Empty>No active or defaulted loans to collect against.</Empty>
        ) : (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
            <label className="block text-sm font-medium sm:col-span-2">
              Loan
              <select
                className="input mt-1"
                value={loanId}
                onChange={(e) => {
                  setLoanId(e.target.value)
                  resetForm()
                }}
              >
                <option value="">Select an active or defaulted loan</option>
                {loans.rows.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.loan_applications?.application_number ?? l.id.slice(0, 8)} — outstanding{' '}
                    {tzs(l.outstanding_balance)}
                    {l.status === 'DEFAULTED' ? ' (defaulted)' : ''}
                  </option>
                ))}
              </select>
            </label>

            {selected && (
              <p className="sm:col-span-2 text-xs text-slate-500">
                Scheduled outstanding: <b>{tzs(scheduled)}</b>
                {pendingOnLoan > 0 && <> · {tzs(pendingOnLoan)} already awaiting verification</>} · available
                to submit now: <b>{tzs(available)}</b>.
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
                  disabled={!available}
                  onClick={() => setAmount(String(available))}
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

            <label className="block text-sm font-medium">
              Transaction reference {needsReference(method) ? '(required)' : '(optional for cash)'}
              <input
                className="input mt-1"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={120}
              />
            </label>

            <label className="block text-sm font-medium">
              Proof of payment {needsReference(method) ? '(required)' : '(optional for cash)'}
              <input
                type="file"
                className="mt-1 block w-full text-xs"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                onChange={(e) => setProof(e.target.files?.[0] ?? null)}
              />
            </label>

            <button className="btn-primary sm:col-span-2" disabled={busy !== null}>
              {busy === 'submit' ? 'Submitting…' : 'Submit for verification'}
            </button>
          </form>
        )}
      </Card>

      {selected && quote && pendingOnLoan === 0 && (
        <Card
          title="Early settlement"
          hint="Principal outstanding plus interest accrued to today. Future interest that has not been earned is written off and recorded."
        >
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500">Principal outstanding</dt>
              <dd><Money value={quote.principal_outstanding} /></dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Interest accrued to {dateTime(quote.as_of)}</dt>
              <dd><Money value={quote.accrued_interest} /></dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Settlement amount</dt>
              <dd className="font-semibold"><Money value={quote.settlement_amount} /></dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Scheduled outstanding</dt>
              <dd><Money value={quote.scheduled_outstanding} /></dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {tzs(Number(quote.scheduled_outstanding) - Number(quote.settlement_amount))} of future
            interest is written off on verification.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Method
              <select
                className="input mt-1"
                value={settleMethod}
                onChange={(e) => setSettleMethod(e.target.value)}
              >
                {METHODS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Transaction reference {needsReference(settleMethod) ? '(required)' : '(optional for cash)'}
              <input
                className="input mt-1"
                value={settleReference}
                onChange={(e) => setSettleReference(e.target.value)}
                maxLength={120}
              />
            </label>
            <label className="block text-sm font-medium sm:col-span-2">
              Proof of payment {needsReference(settleMethod) ? '(required)' : '(optional for cash)'}
              <input
                type="file"
                className="mt-1 block w-full text-xs"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                onChange={(e) => setSettleProof(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <button
            className="btn-primary mt-3"
            disabled={busy !== null}
            onClick={() => void submitSettlement()}
          >
            {busy === 'settle' ? 'Submitting…' : 'Submit settlement for verification'}
          </button>
        </Card>
      )}

      {loanId && (
        <Card
          title="This loan's repayment history"
          hint="Reversed entries are kept and shown struck through, not deleted."
        >
          {history.length === 0 ? (
            <Empty>No repayments recorded against this loan yet.</Empty>
          ) : (
            <Table head={['Recorded', 'Amount', 'Method', 'Reference', 'Status', 'By', '']}>
              {history.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${r.reversed_at ? 'opacity-60' : ''}`}
                >
                  <td className="py-2 pr-3 text-xs text-slate-500">{dateTime(r.paid_at)}</td>
                  <td className={`py-2 pr-3 ${r.reversed_at ? 'line-through' : ''}`}>
                    <Money value={r.amount} />
                    {r.is_settlement && (
                      <span className="ml-1 text-[10px] uppercase text-blue-700">settlement</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs">{r.method.replace('_', ' ')}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.reference ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATUS_TONE[r.status] ?? 'slate'}>
                      {REPAYMENT_STATUS_LABEL[r.status] ?? r.status}
                    </Badge>
                    {r.verification_note && (
                      <p className="mt-1 max-w-xs text-xs text-slate-500">{r.verification_note}</p>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {r.submitted_by === uid ? 'You' : '—'}
                    {r.verified_by === uid ? ' · verified by you' : ''}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {r.reversed_at ? (
                        <span className="text-xs text-slate-500">
                          Reversed{r.reversal_reason ? `: ${r.reversal_reason}` : ''}
                        </span>
                      ) : r.status === 'VERIFIED' && canReverse ? (
                        r.submitted_by === uid || r.verified_by === uid ? (
                          <span className="text-xs text-amber-700">Another officer must reverse</span>
                        ) : (
                          <button
                            className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                            disabled={busy !== null}
                            onClick={() => void reverse(r.id)}
                          >
                            {busy === `reverse-${r.id}` ? 'Reversing…' : 'Reverse'}
                          </button>
                        )
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}

                      {role === 'SUPER_ADMIN' && r.status === 'VERIFIED' && !r.reversed_at && (
                        <button
                          className="btn-outline px-2 py-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => {
                            setAmendFor(amendFor === r.id ? '' : r.id)
                            setAmendAmount(String(r.amount))
                            setAmendReason('')
                          }}
                        >
                          {amendFor === r.id ? 'Cancel' : 'Amend'}
                        </button>
                      )}
                    </div>

                    {amendFor === r.id && (
                      <div className="mt-2 space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
                        <input
                          className="input w-28 py-1 text-xs"
                          type="number"
                          min="0.01"
                          step="0.01"
                          aria-label="Corrected amount"
                          value={amendAmount}
                          onChange={(e) => setAmendAmount(e.target.value)}
                        />
                        <input
                          className="input w-full py-1 text-xs"
                          placeholder="Full reason (audit record)"
                          maxLength={300}
                          value={amendReason}
                          onChange={(e) => setAmendReason(e.target.value)}
                        />
                        <button
                          className="btn-primary px-2 py-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => void amend(r)}
                        >
                          {busy === `amend-${r.id}` ? 'Saving…' : 'Save amendment'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      <p className="text-xs text-slate-400">
        A payment is never confirmed twice, and nobody verifies, rejects or reverses a payment they
        submitted themselves. Corrections are reversal entries; nothing is deleted.
      </p>
    </div>
  )
}
