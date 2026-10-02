import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc } from '../lib/api'
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  STATUS_TONE,
  Table,
  askReason,
  confirmAction,
  dateTime,
} from '../components/ui'
import { ROLE_LABELS, STAFF_ROLES, universityName } from '../config/site'

type Setting = { key: string; value: string; updated_at: string; updated_by: string | null }
type Staff = {
  id: string
  email: string
  role: string
  status: string
  verified: number
  active_loans: number
  outstanding: number
  created_at: string
}
type Person = {
  id: string
  email: string
  role: string
  status: string
  full_name: string | null
  university: string | null
}

type Field = {
  key: string
  label: string
  hint?: string
  kind: 'money' | 'int' | 'rate' | 'months' | 'text'
}

const MONEY_FIELDS: Field[] = [
  {
    key: 'min_loan_amount',
    label: 'Minimum loan amount (TZS)',
    hint: 'Applied to drafts, to submission and to disbursement.',
    kind: 'money',
  },
  {
    key: 'max_loan_amount',
    label: 'Maximum loan amount (TZS)',
    hint: 'This is the ceiling the missing loan cap never had. 0 means no limit — do not leave it there.',
    kind: 'money',
  },
  { key: 'max_active_loans_per_student', label: 'Active loans per student', kind: 'int' },
]

const TERMS_FIELDS: Field[] = [
  { key: 'allowed_repayment_months', label: 'Repayment periods offered (months)', kind: 'months' },
  {
    key: 'annual_interest_rate',
    label: 'Annual interest rate (%)',
    hint: '0 disables interest entirely. Before making this non-zero, confirm the convention below and confirm compliance — this is a commercial and legal decision, not a configuration detail.',
    kind: 'rate',
  },
  {
    key: 'interest_convention',
    label: 'Interest convention',
    hint: 'none = no interest. flat = charged on the original principal for the whole term. reducing_balance = equal monthly payments on a declining balance.',
    kind: 'text',
  },
]

const CONTACT_FIELDS: Field[] = [
  { key: 'institution_name', label: 'Institution name', kind: 'text' },
  { key: 'institution_email', label: 'Institution email', kind: 'text' },
  { key: 'institution_phone', label: 'Institution phone', kind: 'text' },
  { key: 'institution_address', label: 'Institution address', kind: 'text' },
]

function validate(field: Field, raw: string): string | null {
  const v = raw.trim()
  if (field.kind === 'text') return v.length > 200 ? 'Keep this under 200 characters.' : null
  if (v === '') return 'Required.'
  if (field.kind === 'months') {
    const parts = v.split(',').map((p) => p.trim())
    if (parts.length === 0) return 'Enter at least one period, e.g. 6,12,18,24.'
    if (parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) < 1 || Number(p) > 120)) {
      return 'Each period must be a whole number between 1 and 120.'
    }
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return 'Enter a number.'
  if (field.kind === 'money') return n < 0 ? 'Cannot be negative.' : null
  if (field.kind === 'int') return n < 0 || !Number.isInteger(n) ? 'Enter a whole number.' : null
  if (field.kind === 'rate') return n < 0 || n > 100 ? 'Enter a percentage between 0 and 100.' : null
  return null
}

export default function AdminSettings() {
  const { role, session } = useAuth()
  const isSuperAdmin = role === 'SUPER_ADMIN'
  const canEdit = role === 'MANAGER' || isSuperAdmin

  const [settings, setSettings] = useState<Setting[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const [staff, setStaff] = useState<Staff[]>([])
  const [staffError, setStaffError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<Person[]>([])
  const [searching, setSearching] = useState(false)

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error: e } = await supabase
        .from('app_settings')
        .select('key,value,updated_at,updated_by')
        .order('key')
      if (e) throw new Error(e.message)
      const rows = (data ?? []) as Setting[]
      setSettings(rows)
      setDraft(Object.fromEntries(rows.map((r) => [r.key, r.value])))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStaff = useCallback(async () => {
    if (!isSuperAdmin) return
    setStaffError('')
    try {
      const rows = await rpc<Staff>('list_staff')
      setStaff(rows)
    } catch (err) {
      setStaffError(describeError(err))
    }
  }, [isSuperAdmin])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    void loadStaff()
  }, [loadStaff])

  const save = async (field: Field) => {
    setError('')
    setSaved('')
    const value = draft[field.key] ?? ''

    const problem = validate(field, value)
    if (problem) {
      setFieldErr((p) => ({ ...p, [field.key]: problem }))
      return
    }
    setFieldErr((p) => ({ ...p, [field.key]: '' }))

    setSavingKey(field.key)
    const { error: e } = await supabase.rpc('set_setting', { p_key: field.key, p_value: value.trim() })
    setSavingKey(null)

    if (e) {
      setError(describeError(e))
      return
    }
    setSaved(`${field.label} saved.`)
    void loadSettings()
  }

  const changeRole = async (person: Staff, next: string) => {
    setStaffError('')
    if (!confirmAction(`Change ${person.email} from ${person.role} to ${next}?`)) return
    setBusyId(person.id)
    const { error: e } = await supabase.rpc('set_user_role', { p_user_id: person.id, p_role: next })
    setBusyId(null)
    if (e) {
      setStaffError(describeError(e))
      return
    }
    void loadStaff()
  }

  const changeStatus = async (person: Staff, next: 'ACTIVE' | 'SUSPENDED') => {
    setStaffError('')
    if (next === 'SUSPENDED') {
      const reason = askReason(
        `${person.email} will be signed out of every function immediately — no money, no verification, no data access.\n\nReason for suspension (kept in the audit log):`,
      )
      if (reason === null) return
    } else if (!confirmAction(`Reactivate ${person.email}?`)) {
      return
    }

    setBusyId(person.id)
    const { error: e } = await supabase.rpc('set_user_status', { p_user_id: person.id, p_status: next })
    setBusyId(null)
    if (e) {
      setStaffError(describeError(e))
      return
    }
    void loadStaff()
  }

  const findUser = async () => {
    setStaffError('')
    if (!query.trim()) return
    setSearching(true)
    try {
      const rows = await rpc<Person>('find_user', { p_query: query.trim() })
      setPeople(rows)
      if (rows.length === 0) setStaffError('No account matched that email or registration number.')
    } catch (e) {
      setStaffError(describeError(e))
    } finally {
      setSearching(false)
    }
  }

  const grouped = (fields: Field[]) => (
    <div className="grid gap-4 md:grid-cols-2">
      {fields.map((f) => (
        <div key={f.key}>
          <label className="block text-sm font-medium">
            {f.label}
            <input
              className="input mt-1"
              inputMode={f.kind === 'text' ? undefined : 'decimal'}
              value={draft[f.key] ?? ''}
              disabled={!canEdit}
              onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
            />
          </label>
          {f.hint && <p className="mt-1 text-xs text-slate-500">{f.hint}</p>}
          {fieldErr[f.key] && <p className="text-xs text-red-600">{fieldErr[f.key]}</p>}
          {canEdit && (
            <button
              className="btn-outline mt-2 px-3 py-1 text-xs"
              disabled={savingKey === f.key || draft[f.key] === (settings.find((s) => s.key === f.key)?.value ?? '')}
              onClick={() => void save(f)}
            >
              {savingKey === f.key ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Settings</h1>
      <ErrorNote error={error} onRetry={() => void loadSettings()} />
      {saved && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{saved}</p>}

      {loading ? (
        <p className="text-slate-500">Loading settings…</p>
      ) : (
        <>
          <Card title="Loan limits" hint="Enforced in the database, not just in the form. A crafted API call is checked against exactly these values.">
            {grouped(MONEY_FIELDS)}
          </Card>

          <Card title="Repayment terms and interest">
            {grouped(TERMS_FIELDS)}
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              These ship with defaults that OGESEOUS has NOT yet confirmed. Setting an interest rate
              is a commercial and legal decision — including, in Tanzania, whether and how the
              institution is permitted to charge it, and on which convention. Confirm both before
              leaving a non-zero rate here.
            </p>
          </Card>

          <Card title="Institution details" hint="Used in reports and correspondence. The public site reads its copy from src/config/site.ts at build time.">
            {grouped(CONTACT_FIELDS)}
          </Card>
        </>
      )}

      <Card title="Change history" hint="Every settings change is written to the audit log.">
        {settings.length === 0 ? (
          <Empty>No settings loaded.</Empty>
        ) : (
          <Table head={['Key', 'Value', 'Last changed']}>
            {settings.map((s) => (
              <tr key={s.key} className="border-b last:border-0">
                <td className="py-2 pr-3 font-mono text-xs">{s.key}</td>
                <td className="py-2 pr-3">{s.value || <span className="text-slate-400">empty</span>}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  {dateTime(s.updated_at)}
                  {s.updated_by === session?.user.id ? ' (you)' : ''}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {isSuperAdmin ? (
        <>
          <Card
            title="Staff accounts"
            hint="Role assignment is super-admin only: a manager must not be able to mint a super admin. Suspension takes effect immediately, everywhere."
          >
            <ErrorNote error={staffError} />
            {staff.length === 0 ? (
              <Empty>No staff accounts found.</Empty>
            ) : (
              <Table head={['Staff', 'Role', 'Status', 'Verified students', 'Active loans', 'Outstanding', '']}>
                {staff.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 text-xs">{p.email}</td>
                    <td className="py-2 pr-3">
                      <select
                        className="input py-1 text-xs"
                        value={p.role}
                        disabled={busyId === p.id}
                        onChange={(e) => void changeRole(p, e.target.value)}
                      >
                        {STAFF_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs">{p.verified}</td>
                    <td className="py-2 pr-3 text-xs">{p.active_loans}</td>
                    <td className="py-2 pr-3 text-xs">{Number(p.outstanding).toLocaleString('en-TZ')}</td>
                    <td className="py-2 pr-3">
                      {p.id === session?.user.id ? (
                        <span className="text-xs text-slate-400">You</span>
                      ) : p.status === 'ACTIVE' ? (
                        <button
                          className="btn border border-red-300 px-2 py-1 text-xs text-red-700"
                          disabled={busyId === p.id}
                          onClick={() => void changeStatus(p, 'SUSPENDED')}
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          className="btn-outline px-2 py-1 text-xs"
                          disabled={busyId === p.id}
                          onClick={() => void changeStatus(p, 'ACTIVE')}
                        >
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title="Find an account"
            hint="By email address or student registration number. Useful for finding the account behind a repayment reference or a printed application."
          >
            <div className="flex flex-wrap gap-2">
              <input
                className="input flex-1"
                placeholder="Email or registration number"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="btn-blue" disabled={searching} onClick={() => void findUser()}>
                {searching ? 'Searching…' : 'Search'}
              </button>
            </div>
            {people.length > 0 && (
              <Table head={['Name', 'Email', 'University', 'Role', 'Status']}>
                {people.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{p.full_name ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs">{p.email}</td>
                    <td className="py-2 pr-3">{universityName(p.university)}</td>
                    <td className="py-2 pr-3">{p.role}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      ) : (
        <p className="text-xs text-slate-400">
          Staff accounts are administered by a super admin. Ask one to grant or revoke a role.
        </p>
      )}
    </div>
  )
}