import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Table } from '../components/ui'
import { site } from '../config/site'

type Stat = {
  officer_id: string
  full_name: string
  university: string
  referral_code: string
  status: string
  referrals: number
}

export default function AdminMarketing() {
  const { role } = useAuth()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'MANAGER'

  const [stats, setStats] = useState<Stat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [name, setName] = useState('')
  const [uni, setUni] = useState('')
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState('')
  const [formErr, setFormErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStats(await rpc<Stat>('get_marketing_stats'))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (ev: FormEvent) => {
    ev.preventDefault()
    setFormErr('')
    setNotice('')
    setNewCode('')

    if (name.trim().length < 3) return setFormErr("Enter the officer's full name.")
    if (!uni) return setFormErr('Select a university.')

    setBusy(true)
    const { data, error: e } = await supabase.rpc('create_marketing_officer', {
      p_full_name: name,
      p_university: uni,
    })
    setBusy(false)

    if (e) {
      setFormErr(describeError(e))
      return
    }
    const row = (Array.isArray(data) ? data[0] : data) as { referral_code: string } | null
    setNewCode(row?.referral_code ?? '')
    setNotice('Marketing officer created.')
    setName('')
    setUni('')
    void load()
  }

  const total = stats.reduce((s, r) => s + Number(r.referrals), 0)
  const mine = isAdmin ? null : stats[0]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">
        Marketing{isAdmin ? '' : ' — My Referral Code'}
      </h1>

      {/* Was being set after a successful create but never rendered, so an admin who created an
          officer was told nothing at all. */}
      {notice && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      {isAdmin && (
        <Card title="Add a marketing officer">
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-3" noValidate>
            <input
              className="input"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select className="input" value={uni} onChange={(e) => setUni(e.target.value)}>
              <option value="">Select university</option>
              {site.universities.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name}
                </option>
              ))}
            </select>
            <button className="btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create & generate code'}
            </button>
          </form>
          {formErr && <p className="mt-2 text-sm text-red-600">{formErr}</p>}
          {newCode && (
            <p className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">
              Referral number created: <b>{newCode}</b>. Give this to the officer. It works as soon as
              a student signs up with it.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            An officer's login can be linked to their record from <b>/admin/settings → Staff
            accounts</b>, once a super admin gives them the Marketing Officer role. The referral code
            itself is usable immediately either way.
          </p>
        </Card>
      )}

      {mine && !isAdmin && (
        <Card title="Share your referral code">
          <p className="text-sm text-slate-700">
            Your code is{' '}
            <b className="rounded bg-slate-100 px-2 py-1 font-mono">{mine.referral_code}</b>. Students
            who sign up and enter it are counted against your referrals.
          </p>
        </Card>
      )}

      <Card title={isAdmin ? 'Referral performance — all officers' : 'Your performance'}>
        <ErrorNote error={error} onRetry={() => void load()} />
        {loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : stats.length === 0 ? (
          <Empty>No marketing officers yet.</Empty>
        ) : (
          <>
            {isAdmin && (
              <p className="mb-3 text-sm text-slate-600">
                Total tracked sign-ups via marketing officers: <b>{total}</b>
              </p>
            )}
            <Table head={['Officer', 'University', 'Referral no.', 'Status', 'Referrals']}>
              {stats.map((s) => (
                <tr key={s.officer_id} className="border-b last:border-0">
                  <td className="py-2 pr-3">{s.full_name}</td>
                  <td className="py-2 pr-3">{s.university}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{s.referral_code}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={s.status === 'ACTIVE' ? 'green' : 'slate'}>{s.status}</Badge>
                  </td>
                  <td className="py-2 pr-3 font-semibold">{s.referrals}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}