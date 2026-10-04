import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeError, rpcOne } from '../lib/api'
import { Card, Empty, ErrorNote, Money, Table } from '../components/ui'

type Stats = {
  total_students: number
  verified_students: number
  total_applications: number
  submitted_applications: number
  approved_applications: number
  total_disbursed: number
  total_collected: number
  outstanding_portfolio: number
  active_loans: number
  total_repayable: number
  interest_billed: number
  overdue_balance: number
  loans_in_arrears: number
}
type Uni = { university: string; applications: number; approved: number }

export default function AdminReports() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [byUni, setByUni] = useState<Uni[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [s, u] = await Promise.all([
        rpcOne<Stats>('get_dashboard_stats'),
        supabase.rpc('get_applications_by_university').then((r) => {
          if (r.error) throw new Error(r.error.message)
          return r.data ?? []
        }),
      ])
      // These functions return ZERO ROWS for a role that is not allowed to see the figures, rather
      // than an error. That distinction is the point: null means "not permitted", and it is shown
      // as such instead of being rendered as a page of zeros.
      setStats(s)
      setByUni(u as Uni[])
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  if (loading) return <p className="py-10 text-center text-slate-500">Loading…</p>

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Reports</h1>
      <ErrorNote error={error} onRetry={() => void load()} />

      {!stats ? (
        <Card title="Financial summary">
          <Empty>
            These figures are not available for your role. get_dashboard_stats() is readable by
            accountants, managers and super admins only.
          </Empty>
        </Card>
      ) : (
        <>
          <Card title="Money">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Disbursed" value={<Money value={stats.total_disbursed} />} />
              <Stat label="Collected" value={<Money value={stats.total_collected} />} />
              <Stat label="Outstanding portfolio" value={<Money value={stats.outstanding_portfolio} />} />
              <Stat label="Active loans" value={stats.active_loans} />
              <Stat
                label="Overdue balance"
                value={<Money value={stats.overdue_balance} />}
                tone={Number(stats.overdue_balance) > 0 ? 'red' : undefined}
              />
              <Stat
                label="Loans in arrears"
                value={stats.loans_in_arrears}
                tone={stats.loans_in_arrears > 0 ? 'red' : undefined}
              />
              <Stat label="Total scheduled" value={<Money value={stats.total_repayable} />} />
              <Stat label="Interest billed" value={<Money value={stats.interest_billed} />} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              "Total scheduled" is everything the generated installment schedules will ever collect;
              "Interest billed" is that figure less the principal advanced. With the default settings
              the interest rate is 0, so interest billed is 0 and each installment is an equal share
              of the principal.
            </p>
          </Card>

          <Card title="Applications">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Total applications" value={stats.total_applications} />
              <Stat label="Submitted" value={stats.submitted_applications} />
              <Stat label="Awaiting disbursement" value={stats.approved_applications} />
              <Stat label="Students (active)" value={stats.total_students} />
              <Stat label="Verified students" value={stats.verified_students} />
            </div>
          </Card>
        </>
      )}

      <Card title="Applications by university">
        {byUni.length === 0 ? (
          <Empty>
            No application figures are available for your role, or no applications have been
            submitted yet.
          </Empty>
        ) : (
          <Table head={['University', 'Applications', 'Approved']}>
            {byUni.map((u) => (
              <tr key={u.university} className="border-b last:border-0">
                <td className="py-2 pr-3">{u.university}</td>
                <td className="py-2 pr-3">{u.applications}</td>
                <td className="py-2 pr-3">{u.approved}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

const Stat = ({
  label,
  value,
  tone,
}: {
  label: string
  value: React.ReactNode
  tone?: 'red'
}) => (
  <div className="rounded-lg border border-slate-200 p-3">
    <p className="text-xs text-slate-500">{label}</p>
    <p className={`mt-1 text-lg font-semibold ${tone === 'red' ? 'text-red-700' : 'text-navy'}`}>{value}</p>
  </div>
)