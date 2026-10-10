import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Money, PageHeader, Pager, STATUS_TONE, Table, askReason, confirmAction } from '../components/ui'
import { STATUS_LABEL, purposeText as purpose } from '../lib/application'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../config/site'

const PAGE_SIZE = 25

type Row = {
  id: string
  application_number: string | null
  amount: number
  purpose: string
  purpose_other: string | null
  repayment_period_months: number
  status: string
  submitted_at: string | null
  action_required_note: string | null
}

/** The statuses an officer may still act on, in the order they normally happen. */
const REVIEWABLE = ['SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED']
const FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'ACTION_REQUIRED', label: 'Action required' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'DISBURSED', label: 'Disbursed' },
  { value: 'COMPLETED', label: 'Completed' },
]

/**
 * The review queue.
 *
 * Drafts are excluded, and not as a cosmetic choice: a draft belongs to the student, who has not
 * asked to be assessed yet, and letting it appear here would mean a decision could be taken on an
 * application whose owner is still typing into it.
 *
 * Decisions here are the same ones available on the detail page, kept inline for the common case
 * because a reviewer working a queue should not have to open a record to say "keep under review".
 * Anything more than a one-click transition belongs on /admin/applications/:id, where the documents
 * and the financial picture are in front of the person making the call.
 */
export default function AdminLoanApplications() {
  const { role } = useAuth()
  const canAssess = hasPermission(role, 'applications.assess')
  const canApprove = hasPermission(role, 'applications.approve')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

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
        .order('submitted_at', { ascending: false })
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

  const act = async (id: string, decision: 'UNDER_REVIEW' | 'ACTION_REQUIRED' | 'APPROVED' | 'REJECTED') => {
    setActionError('')

    let note: string | null = null
    if (decision === 'ACTION_REQUIRED') {
      const given = askReason(
        'What do you need from the student? This note is shown to them on their dashboard and on ' +
          'the public tracking page, so say it in plain words.',
        5,
      )
      if (given === null) return
      note = given
    }
    if (decision === 'REJECTED') {
      const given = askReason('Reason for rejection (shown to the student):', 5)
      if (given === null) return
      note = given
    }
    if (
      decision === 'APPROVED' &&
      !confirmAction(
        'Approve this application? Approval is a commitment to lend. Open the application and check ' +
          'the documents first if you have not already.',
      )
    )
      return

    setBusyId(id)
    const { error } = await supabase.rpc('review_loan_application', {
      p_id: id,
      p_decision: decision,
      p_notes: note,
    })
    setBusyId(null)

    if (error) return setActionError(describeError(error))
    list.reload()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loan Applications"
        hint="Workflow: 01 Student submits → 02 Loan Officer verifies and assesses → 03 CEO approves or rejects (Manager may approve under delegated oversight) → 04 Accountant disburses → 05 Loan Officer confirms loan records and the repayment schedule is available to the student → 06 Collection Officer follows up under Loan Officer supervision; Marketing staff handle outreach separately → 07 Accountant records and reconciles payments → 08 CEO reviews financial and overdue-loan reports. Drafts are excluded until submitted."
      />

      <Card hint="A draft saved by a student is not shown here — it has not been submitted yet.">
        <ErrorNote error={list.error || actionError} onRetry={list.reload} />

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
            <Table head={['App no.', 'Amount', 'Purpose', 'Term', 'Status', 'Submitted', 'Action']}>
              {list.rows.map((r) => (
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
                  <td className="py-2 pr-3 text-xs">{r.repayment_period_months} mo</td>
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
                    {REVIEWABLE.includes(r.status) ? (
                      <div className="flex flex-wrap gap-1">
                        <Link
                          className="btn-outline px-2 py-1 text-xs"
                          to={`/admin/applications/${r.id}`}
                        >
                          Open
                        </Link>
                        {canApprove && (
                          <>
                            <button
                              className="btn-primary px-2 py-1 text-xs"
                              disabled={busyId === r.id}
                              onClick={() => void act(r.id, 'APPROVED')}
                            >
                              Approve
                            </button>
                            <button
                              className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                              disabled={busyId === r.id}
                              onClick={() => void act(r.id, 'REJECTED')}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {canAssess && (
                          <button
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={busyId === r.id || r.status === 'UNDER_REVIEW'}
                            onClick={() => void act(r.id, 'ACTION_REQUIRED')}
                          >
                            Request info
                          </button>
                        )}
                      </div>
                    ) : (
                      <Link className="text-xs text-brand underline" to={`/admin/applications/${r.id}`}>
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
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