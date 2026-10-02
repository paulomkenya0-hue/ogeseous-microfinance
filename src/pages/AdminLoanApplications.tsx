import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Money, Pager, STATUS_TONE, Table, askReason } from '../components/ui'

const PAGE_SIZE = 25

type Row = {
  id: string
  application_number: string
  amount: number
  purpose: string
  purpose_other: string | null
  repayment_period_months: number
  status: string
  submitted_at: string | null
}

export default function AdminLoanApplications() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  /**
   * Paginated. The original fetched every non-draft application in one unbounded query and
   * rendered them all, which is fine at demo scale and stops being fine the first month a
   * branch has a few hundred students.
   */
  const list = useAdminList<Row>(
    (from, to) =>
      supabase
        .from('loan_applications')
        .select('id,application_number,amount,purpose,purpose_other,repayment_period_months,status,submitted_at', {
          count: 'exact',
        })
        .not('status', 'eq', 'DRAFT')
        .order('submitted_at', { ascending: false })
        .range(from, to),
    PAGE_SIZE,
  )

  const act = async (id: string, decision: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED') => {
    setActionError('')
    const notes =
      decision === 'REJECTED' ? askReason('Reason for rejection (shown to the student):') : undefined
    if (decision === 'REJECTED' && notes === undefined) return

    setBusyId(id)
    const { error } = await supabase.rpc('review_loan_application', {
      p_id: id,
      p_decision: decision,
      p_notes: notes ?? null,
    })
    setBusyId(null)

    if (error) {
      setActionError(describeError(error))
      return
    }
    list.reload()
  }

  const purposeText = (r: Row) => (r.purpose === 'OTHER' ? r.purpose_other || 'Other' : r.purpose)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Loan Applications</h1>

      <Card hint="A draft saved by a student is not shown here — it has not been submitted yet.">
        <ErrorNote error={list.error || actionError} onRetry={list.reload} />

        {list.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : list.rows.length === 0 ? (
          <Empty>No submitted applications yet.</Empty>
        ) : (
          <>
            <Table head={['App no.', 'Amount', 'Purpose', 'Term', 'Status', 'Submitted', 'Action']}>
              {list.rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{r.application_number}</td>
                  <td className="py-2 pr-3">
                    <Money value={r.amount} />
                  </td>
                  <td className="py-2 pr-3">{purposeText(r)}</td>
                  <td className="py-2 pr-3 text-xs">{r.repayment_period_months} mo</td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 pr-3">
                    {['SUBMITTED', 'UNDER_REVIEW'].includes(r.status) ? (
                      <div className="flex flex-wrap gap-1">
                        {r.status === 'SUBMITTED' && (
                          <button
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={busyId === r.id}
                            onClick={() => void act(r.id, 'UNDER_REVIEW')}
                          >
                            Start review
                          </button>
                        )}
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
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
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