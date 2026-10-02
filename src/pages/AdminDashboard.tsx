import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc, rpcOne } from '../lib/api'
import { Card, ErrorNote, Money } from '../components/ui'

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

/**
 * Replaces the "Coming in next development phase" card that /admin showed.
 *
 * Each block is fetched independently and each can legitimately be unavailable: get_dashboard_stats
 * returns ZERO ROWS (not an error) for roles that may not see financials, which is why an empty
 * array is reported as "not available for your role" rather than rendered as a row of zeroes.
 */
export default function AdminDashboard() {
  const { role } = useAuth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [arrears, setArrears] = useState<Arrear[] | null>(null)
  const [pendingVerify, setPendingVerify] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const run = async () => {
      setLoading(true)
      setError('')

      const canSeeFinancials = role === 'ACCOUNTANT' || role === 'MANAGER' || role === 'SUPER_ADMIN'
      const canSeeArrears =
        role === 'ACCOUNTANT' || role === 'COLLECTION_OFFICER' || role === 'MANAGER' || role === 'SUPER_ADMIN'
      const canSeeVerification = role === 'MANAGER' || role === 'SUPER_ADMIN'

      try {
        // Each block is fetched on its own so that one denied query does not blank the whole
      // dashboard, and so a role that may not see a block gets "not available" rather than zeros.
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
      ])

      if (!active) return

      const problems: string[] = []

      const [statsResult, arrearsResult, verifyResult] = settled

      if (statsResult.status === 'rejected') {
        problems.push(describeError(statsResult.reason))
      } else if (statsResult.value) {
        setStats(statsResult.value)
      }

      if (arrearsResult.status === 'rejected') {
        problems.push(describeError(arrearsResult.reason))
      } else if (arrearsResult.value) {
        setArrears(arrearsResult.value)
      }

      if (verifyResult.status === 'rejected') {
        problems.push(describeError(verifyResult.reason))
      } else if (verifyResult.value !== null) {
        setPendingVerify(verifyResult.value)
      }

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

  if (loading) return <p className="py-10 text-center text-slate-500">Loading…</p>

  const overdueTotal = arrears?.reduce((s, a) => s + Number(a.outstanding), 0) ?? 0
  const worstDays = arrears?.reduce((m, a) => Math.max(m, Number(a.days_overdue)), 0) ?? 0

  const blocks: { heading: string; children: React.ReactNode }[] = []

  if (stats) {
    blocks.push({
      heading: 'Portfolio',
      children: (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Disbursed" value={<Money value={stats.total_disbursed} />} />
          <Stat label="Collected" value={<Money value={stats.total_collected} />} />
          <Stat label="Outstanding" value={<Money value={stats.outstanding_portfolio} />} />
          <Stat label="Active loans" value={stats.active_loans} />
          <Stat label="Students (active)" value={stats.total_students} />
          <Stat label="Verified students" value={stats.verified_students} />
          <Stat label="Applications submitted" value={stats.submitted_applications} />
          <Stat label="Awaiting disbursement" value={stats.approved_applications} />
        </div>
      ),
    })
  } else if (role === 'ACCOUNTANT' || role === 'MANAGER' || role === 'SUPER_ADMIN') {
    blocks.push({ heading: 'Portfolio', children: <p className="text-slate-600">No portfolio figures are available for your role.</p> })
  }

  if (arrears) {
    blocks.push({
      heading: 'Collections',
      children: (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Loans in arrears" value={arrears.length} tone={arrears.length > 0 ? 'red' : undefined} />
          <Stat label="Overdue balance" value={<Money value={overdueTotal} />} tone={overdueTotal > 0 ? 'red' : undefined} />
          <Stat label="Longest overdue" value={worstDays === 0 ? '—' : `${worstDays} days`} />
        </div>
      ),
    })
  }

  if (pendingVerify !== null) {
    blocks.push({
      heading: 'Verification queue',
      children: (
        <p className="text-sm text-slate-700">
          <b>{pendingVerify}</b> student verification request{pendingVerify === 1 ? '' : 's'} awaiting review.{' '}
          {/* A plain href would be origin-rooted and 404 on a sub-path deploy. */}
          <Link className="text-brand underline" to="/admin/students">
            Open the verification queue
          </Link>
        </p>
      ),
    })
  }

  if (blocks.length === 0) {
    return <p className="text-slate-600">Nothing on this dashboard applies to your role.</p>
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Dashboard</h1>
      <ErrorNote error={error} />
      {blocks.map((b) => (
        <Card key={b.heading} title={b.heading}>
          {b.children}
        </Card>
      ))}
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