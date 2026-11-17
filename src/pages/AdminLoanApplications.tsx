import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { useAuth } from '../auth/AuthContext'
import { Badge, Card, Empty, ErrorNote, Money, Pager, STATUS_TONE, Table } from '../components/ui'
import {
  MANAGER_ACTION_STATUSES,
  LOAN_OFFICER_ACTION_STATUSES,
  ACCOUNTANT_TERMS_STATUSES,
  MANAGER_TERMS_STATUSES,
  STATUS_LABEL,
  isOneOf,
  monthsLabel,
  purposeText as purpose,
} from '../lib/application'

const PAGE_SIZE = 25

type Row = {
  id: string
  application_number: string | null
  amount: number | null
  purpose: string | null
  purpose_other: string | null
  repayment_period_months: number | null
  status: string
  submitted_at: string | null
  action_required_note: string | null
}

/**
 * Statuses worth filtering by, in the order an application normally passes through them. The list
 * is deliberately a subset of the full status vocabulary: a filter for a status nobody can usefully
 * search for is just a longer dropdown.
 */
const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING_LOAN_OFFICER', label: 'With the loan officer' },
  { value: 'RETURNED_TO_LOAN_OFFICER', label: 'Returned to the loan officer' },
  { value: 'ACTION_REQUIRED', label: 'Action required from student' },
  { value: 'PENDING_MANAGER', label: 'With the manager' },
  { value: 'PENDING_ACCOUNTANT', label: 'With the accountant' },
  { value: 'RETURNED_TO_ACCOUNTANT', label: 'Terms returned to accountant' },
  { value: 'PENDING_TERMS_APPROVAL', label: 'Terms awaiting manager' },
  { value: 'TERMS_APPROVED', label: 'Terms awaiting student' },
  { value: 'TERMS_ACCEPTED', label: 'Terms accepted — to disburse' },
  { value: 'DISBURSED', label: 'Disbursed' },
  { value: 'PAID_OFF', label: 'Paid off — to reconcile' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'REJECTED', label: 'Rejected' },
]

/**
 * The queue every stage of the workflow reads.
 *
 * The decisions themselves live on /admin/applications/:id. They used to be available inline here
 * as one-click buttons, which was fine while a single "review" step covered the whole workflow — an
 * officer could approve without opening the file. The sequential workflow makes that unsafe: a
 * forward has a mandatory assessment note, a manager's decision has a mandatory comment, and both
 * are meant to be made with the documents and the financial picture on screen. So this page only
 * finds the application and says whether it is your turn.
 *
 * Drafts are excluded: a draft belongs to the student, who has not asked to be assessed yet.
 */
export default function AdminLoanApplications() {
  const { role } = useAuth()
  const isSuper = role === 'SUPER_ADMIN'

  const [searchInput, setSearchInput] = useState('')
  const [statusInput, setStatusInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const list = useAdminList<Row>(
    (from, to) => {
      let q = supabase
        .from('loan_applications')
        .select(
          'id,application_number,amount,purpose,purpose_other,repayment_period_months,status,submitted_at,action_required_note',
          { count: 'exact' },
        )
        .not('status', 'eq', 'DRAFT')
        .order('submitted_at', { ascending: false, nullsFirst: false })
      if (status) q = q.eq('status', status)
      // An empty box must search for nothing rather than for "%%", which PostgREST reads as
      // "match every row" and quietly turns the filter off.
      if (search) q = q.ilike('application_number', `%${search}%`)
      return q.range(from, to)
    },
    PAGE_SIZE,
  )

  const apply = (e: FormEvent) => {
    e.preventDefault()
    setSearch(searchInput.trim())
    setStatus(statusInput)
    // The list hook re-runs on page and on a reload tick. Applying a filter changes neither on its
    // own, so both are nudged here — setPage(0) so a page-3 view does not stay on page 3 of a
    // two-page result, and the reload tick to actually issue the new query.
    list.setPage(0)
    list.reload()
  }

  /** Whether this row is waiting on the signed-in role. Mirrors each RPC's own check. */
  const myTurn = (s: string): boolean => {
    if (isSuper) return true
    switch (role) {
      case 'LOAN_OFFICER':
        return isOneOf(LOAN_OFFICER_ACTION_STATUSES, s)
      case 'MANAGER':
        return isOneOf(MANAGER_ACTION_STATUSES, s) || isOneOf(MANAGER_TERMS_STATUSES, s)
      case 'ACCOUNTANT':
        return isOneOf(ACCOUNTANT_TERMS_STATUSES, s) || s === 'TERMS_ACCEPTED' || s === 'PAID_OFF'
      default:
        return false
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Loan Applications</h1>

      <Card hint="A draft saved by a student is not shown here — it has not been submitted yet.">
        <ErrorNote error={list.error} onRetry={list.reload} />

        <form onSubmit={apply} className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Application number
            <input
              className="input mt-1 font-mono"
              placeholder="OGS-2026-000"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="text-sm font-medium">
            Status
            <select
              className="input mt-1"
              value={statusInput}
              onChange={(e) => setStatusInput(e.target.value)}
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn-blue" type="submit">
            Filter
          </button>
          {(search || status) && (
            <button
              className="btn-outline"
              type="button"
              onClick={() => {
                setSearchInput('')
                setStatusInput('')
                setSearch('')
                setStatus('')
                list.setPage(0)
                list.reload()
              }}
            >
              Clear
            </button>
          )}
        </form>

        {list.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : list.rows.length === 0 ? (
          <Empty>
            {search || status
              ? 'No application matches that filter.'
              : 'No submitted applications yet.'}
          </Empty>
        ) : (
          <>
            <Table head={['App no.', 'Amount', 'Purpose', 'Term', 'Status', 'Submitted', '']}>
              {list.rows.map((r) => {
                const mine = myTurn(r.status)
                return (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">
                      <Link className="underline" to={`/admin/applications/${r.id}`}>
                        {r.application_number ?? 'Draft'}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      <Money value={r.amount} />
                    </td>
                    <td className="py-2 pr-3 text-xs">{purpose(r.purpose, r.purpose_other)}</td>
                    <td className="py-2 pr-3 text-xs">{monthsLabel(r.repayment_period_months)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={STATUS_TONE[r.status] ?? 'slate'}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </Badge>
                      {r.action_required_note && r.status === 'ACTION_REQUIRED' && (
                        <p className="mt-1 max-w-xs text-xs text-amber-800">{r.action_required_note}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <Link
                        className={mine ? 'btn-primary px-2 py-1 text-xs' : 'btn-outline px-2 py-1 text-xs'}
                        to={`/admin/applications/${r.id}`}
                      >
                        {mine ? 'Needs your action' : 'Open'}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </Table>
            {list.pageable && (
              <Pager page={list.page} count={list.count} pageSize={PAGE_SIZE} onPage={list.setPage} />
            )}
          </>
        )}
      </Card>
    </div>
  )
}
