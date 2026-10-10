import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../config/site'
import { describeError, rpc, rpcOne } from '../lib/api'
import { Card, Empty, ErrorNote, Kpi, Money, PageHeader, Skeleton } from '../components/ui'
import ImageCarousel from '../components/ImageCarousel'
import MarqueeStrip from '../components/MarqueeStrip'
import SimpleBars from '../components/SimpleBars'
import { HERO_SLIDES, MARQUEE_CARDS } from '../config/banners'

type Stats = {
  total_students: number
  verified_students: number
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
type Arrear = { loan_id: string; outstanding: number; days_overdue: number; installments_missed: number }
type QueueCounts = { pending: number | null; approved: number | null; activeLoans: number | null }
type RecentApp = { id: string; application_number: string | null; status: string; amount: number | null }

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, value)
  if (error) throw new Error(error.message)
  return count ?? 0
}

export default function AdminDashboard() {
  const { role } = useAuth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [arrears, setArrears] = useState<Arrear[] | null>(null)
  const [pendingVerify, setPendingVerify] = useState<number | null>(null)
  const [queue, setQueue] = useState<QueueCounts | null>(null)
  const [recent, setRecent] = useState<RecentApp[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const run = async () => {
      setLoading(true)
      setError('')

      const canSeeFinancials = hasPermission(role, 'reports.view')
      const canSeeArrears = hasPermission(role, 'collections.view')
      const canSeeVerification = hasPermission(role, 'customers.view')
      const canSeeApplications = hasPermission(role, 'applications.view')
      const canSeeLoans = hasPermission(role, 'loans.view')

      try {
        const settled = await Promise.allSettled([
          canSeeFinancials ? rpcOne<Stats>('get_dashboard_stats') : Promise.resolve(null),
          canSeeArrears ? rpc<Arrear>('list_arrears') : Promise.resolve(null),
          canSeeVerification
            ? supabase
                .from('verification_requests')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'PENDING')
                .then((r) => {
                  if (r.error) throw new Error(r.error.message)
                  return r.count
                })
            : Promise.resolve(null),
          canSeeApplications || canSeeLoans
            ? Promise.all([
                canSeeApplications ? countWhere('loan_applications', 'status', 'UNDER_REVIEW') : Promise.resolve(null),
                canSeeApplications ? countWhere('loan_applications', 'status', 'APPROVED') : Promise.resolve(null),
                canSeeLoans ? countWhere('loans', 'status', 'ACTIVE') : Promise.resolve(null),
              ]).then(([pending, approved, activeLoans]) => ({ pending, approved, activeLoans }))
            : Promise.resolve(null),
          canSeeApplications
            ? supabase
                .from('loan_applications')
                .select('id,application_number,status,amount')
                .not('status', 'eq', 'DRAFT')
                .order('submitted_at', { ascending: false })
                .limit(6)
                .then((r) => {
                  if (r.error) throw new Error(r.error.message)
                  return (r.data ?? []) as RecentApp[]
                })
            : Promise.resolve(null),
        ])

        if (!active) return
        const problems: string[] = []
        const [statsResult, arrearsResult, verifyResult, queueResult, recentResult] = settled

        if (statsResult.status === 'rejected') problems.push(describeError(statsResult.reason))
        else if (statsResult.value) setStats(statsResult.value)

        if (arrearsResult.status === 'rejected') problems.push(describeError(arrearsResult.reason))
        else if (arrearsResult.value) setArrears(arrearsResult.value)

        if (verifyResult.status === 'rejected') problems.push(describeError(verifyResult.reason))
        else if (verifyResult.value !== null) setPendingVerify(verifyResult.value)

        if (queueResult.status === 'rejected') problems.push(describeError(queueResult.reason))
        else if (queueResult.value) setQueue(queueResult.value)

        if (recentResult.status === 'rejected') problems.push(describeError(recentResult.reason))
        else if (recentResult.value) setRecent(recentResult.value)

        setError(problems.join(' '))
      } finally {
        if (active) setLoading(false)
      }
    }

    void run()
    return () => {
      active = false
    }
  }, [role])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="aspect-[21/9]" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      </div>
    )
  }

  const overdueTotal = arrears?.reduce((s, a) => s + Number(a.outstanding), 0) ?? 0
  const worstDays = arrears?.reduce((m, a) => Math.max(m, Number(a.days_overdue)), 0) ?? 0
  const hasAnything = stats || arrears || pendingVerify !== null || queue || (recent && recent.length > 0)

  return (
    <div className="page-shell">
      <PageHeader
        title="Dashboard"
        hint={
          role === 'CEO'
            ? 'Executive oversight: loan approvals, portfolio performance, and overdue balances.'
            : role === 'LOAN_OFFICER'
            ? 'Application queue and loans you are authorised to review.'
            : role === 'ACCOUNTANT'
              ? 'Portfolio totals and repayment figures from the live database.'
              : role === 'COLLECTION_OFFICER'
                ? 'Arrears and overdue follow-up from installment schedules.'
                : 'Live figures from the database. Empty cards mean no rows, not invented zeros.'
        }
      />

      <ImageCarousel slides={HERO_SLIDES} />
      <MarqueeStrip cards={MARQUEE_CARDS} />
      <ErrorNote error={error} />

      {role === 'CEO' && (
        <Card title="Chief Executive Officer (CEO) — leadership mandate">
          <ul className="grid gap-2 text-sm text-slate-700 md:grid-cols-2">
            <li>Provide overall leadership and direction.</li>
            <li>Develop and implement the institution's vision, mission, and strategy.</li>
            <li>Supervise and coordinate senior staff.</li>
            <li>Ensure the institution achieves its objectives.</li>
            <li>Build relationships with customers, investors, and other stakeholders.</li>
            <li>Ensure compliance with applicable laws and regulations.</li>
            <li>Make major business and operating decisions.</li>
          </ul>
        </Card>
      )}

      {!hasAnything ? (
        <Empty>Nothing on this dashboard applies to your role, or the data source is unavailable.</Empty>
      ) : null}

      {queue && (
        <div className="grid gap-3 sm:grid-cols-3">
          {queue.pending !== null && (
            <Kpi label="Pending review" value={queue.pending} tone={queue.pending > 0 ? 'amber' : undefined} />
          )}
          {queue.approved !== null && (
            <Kpi label="Approved, awaiting disbursement" value={queue.approved} tone="green" />
          )}
          {queue.activeLoans !== null && <Kpi label="Active loans" value={queue.activeLoans} />}
        </div>
      )}

      {stats && (
        <Card title="Portfolio" hint="From get_dashboard_stats(). Unavailable roles see no zeros here.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Students" value={stats.total_students} />
            <Kpi label="Submitted applications" value={stats.submitted_applications} />
            <Kpi label="Approved applications" value={stats.approved_applications} tone="green" />
            <Kpi label="Active loans" value={stats.active_loans} />
            <Kpi label="Disbursed" value={<Money value={stats.total_disbursed} />} />
            <Kpi label="Repayments received" value={<Money value={stats.total_collected} />} />
            <Kpi label="Outstanding" value={<Money value={stats.outstanding_portfolio} />} />
            <Kpi
              label="Overdue"
              value={<Money value={stats.overdue_balance} />}
              tone={Number(stats.overdue_balance) > 0 ? 'red' : undefined}
            />
          </div>
          <div className="mt-6">
            <SimpleBars
              items={[
                { label: 'Disbursed', value: Number(stats.total_disbursed) },
                { label: 'Collected', value: Number(stats.total_collected) },
                { label: 'Outstanding', value: Number(stats.outstanding_portfolio) },
                { label: 'Overdue', value: Number(stats.overdue_balance) },
              ]}
            />
          </div>
        </Card>
      )}

      {arrears && (
        <Card
          title="Collections"
          actions={
            <Link className="btn-outline py-2 text-xs" to="/admin/collections">
              Open collections
            </Link>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Loans in arrears" value={arrears.length} tone={arrears.length > 0 ? 'red' : undefined} />
            <Kpi label="Overdue balance" value={<Money value={overdueTotal} />} tone={overdueTotal > 0 ? 'red' : undefined} />
            <Kpi label="Longest overdue" value={worstDays === 0 ? '—' : `${worstDays} days`} />
          </div>
        </Card>
      )}

      {pendingVerify !== null && (
        <Card title="Verification queue">
          <p className="text-sm text-slate-700">
            <b>{pendingVerify}</b> student verification request{pendingVerify === 1 ? '' : 's'} awaiting review.{' '}
            <Link className="text-brand underline" to="/admin/students">
              Open the verification queue
            </Link>
          </p>
        </Card>
      )}

      {recent && (
        <Card title="Recent applications">
          {recent.length === 0 ? (
            <Empty>No submitted applications yet.</Empty>
          ) : (
            <ul className="divide-y">
              {recent.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <Link className="font-mono text-navy hover:underline" to={`/admin/applications/${row.id}`}>
                    {row.application_number ?? row.id.slice(0, 8)}
                  </Link>
                  <span className="text-slate-500">{row.status.replace(/_/g, ' ')}</span>
                  <Money value={row.amount} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Shortcuts">
        <div className="flex flex-wrap gap-2">
          {hasPermission(role, 'applications.view') ? (
            <Link className="btn-blue" to="/admin/applications">
              {hasPermission(role, 'applications.approve') ? 'Review loan approvals' : 'Review applications'}
            </Link>
          ) : null}
          {hasPermission(role, 'loans.disburse') ? (
            <Link className="btn-outline" to="/admin/loans">
              Disburse approved loans
            </Link>
          ) : null}
          {hasPermission(role, 'repayments.record') ? (
            <Link className="btn-outline" to="/admin/repayments">
              Record a repayment
            </Link>
          ) : null}
          {hasPermission(role, 'collections.view') ? (
            <Link className="btn-outline" to="/admin/collections">
              {hasPermission(role, 'collections.manage') ? 'Follow up arrears' : 'Review overdue balances'}
            </Link>
          ) : null}
          {hasPermission(role, 'reports.view') ? (
            <Link className="btn-outline" to="/admin/reports">
              Open reports
            </Link>
          ) : null}
          {hasPermission(role, 'marketing.view') ? (
            <Link className="btn-outline" to="/admin/marketing">
              Marketing referrals
            </Link>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
