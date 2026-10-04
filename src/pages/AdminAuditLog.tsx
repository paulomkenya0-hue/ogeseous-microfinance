import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError, rpc } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Pager, Table, dateTime } from '../components/ui'

const PAGE_SIZE = 50

type LogRow = {
  id: string
  actor_id: string | null
  action: string
  entity: string
  entity_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
type ActionRow = { action: string; times: number }

/**
 * The audit log had no way to be read at all: nothing in the app queried it. Every approval,
 * disbursement, repayment, reversal, role change and settings edit writes to it, and RLS limits
 * reading to managers and super admins — so this page is the control, not a nicety.
 */
export default function AdminAuditLog() {
  const [filter, setFilter] = useState('')
  const [actions, setActions] = useState<ActionRow[]>([])
  const [actionError, setActionError] = useState('')

  const list = useAdminList<LogRow>(
    (from, to) => {
      let q = supabase
        .from('audit_logs')
        .select('id,actor_id,action,entity,entity_id,metadata,created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)
      if (filter) q = q.eq('action', filter)
      return q
    },
    PAGE_SIZE,
  )

  const loadActions = async () => {
    setActionError('')
    try {
      setActions(await rpc<ActionRow>('list_audit_actions'))
    } catch (e) {
      setActionError(describeError(e))
    }
  }

  // The action list is stable enough not to need reloading on every filter change.
  useEffect(() => {
    void loadActions()
  }, [])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Audit Log</h1>

      <Card
        title="Recorded activity"
        hint="Newest first. Rows are never deleted — a reversed repayment stays visible with its reversal beside it."
      >
        <ErrorNote error={list.error || actionError} onRetry={list.reload} />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            className="input w-auto py-1 text-sm"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              list.setPage(0)
            }}
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.times})
              </option>
            ))}
          </select>
          {filter && (
            <button
              className="btn-outline px-3 py-1 text-xs"
              onClick={() => {
                setFilter('')
                list.setPage(0)
              }}
            >
              Clear
            </button>
          )}
          <button className="btn-outline px-3 py-1 text-xs" onClick={list.reload}>
            Refresh
          </button>
        </div>

        {list.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : list.rows.length === 0 ? (
          <Empty>
            No audit entries{filter ? ' for this action' : ''} yet. The log fills up as staff approve,
            disburse and collect.
          </Empty>
        ) : (
          <>
            <Table head={['When', 'Action', 'Entity', 'Reference', 'Actor', 'Detail']}>
              {list.rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 text-xs whitespace-nowrap text-slate-500">
                    {dateTime(r.created_at)}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={toneFor(r.action)}>{r.action.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs">{r.entity}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">{r.entity_id ?? '—'}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">{r.actor_id ?? 'system'}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {r.metadata && Object.keys(r.metadata).length > 0 ? (
                      <code className="block max-w-md overflow-x-auto whitespace-pre-wrap break-words">
                        {JSON.stringify(r.metadata)}
                      </code>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager page={list.page} count={list.count} pageSize={PAGE_SIZE} onPage={list.setPage} />
          </>
        )}
      </Card>

      <p className="text-xs text-slate-400">
        An entry is written for every sensitive action, including failed attempts to change a
        verified identity. Use the action filter to trace one loan end to end: LOAN DISBURSED →
        REPAYMENT RECORDED → REPAYMENT REVERSED.
      </p>
    </div>
  )
}

/** Money-moving and identity actions stand out; routine reads stay quiet. */
function toneFor(action: string) {
  if (/REVERS|VOID|ROLE_CHANGED|STATUS_CHANGED|DEFAULTED/.test(action)) return 'red' as const
  if (/DISBURS|APPROV|VERIFIED|REPAYMENT_RECORDED|ACCOUNT_DELETED/.test(action)) return 'green' as const
  if (/REJECT/.test(action)) return 'amber' as const
  return 'slate' as const
}