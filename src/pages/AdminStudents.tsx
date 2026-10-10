import { useState } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { normalizeRucuStudentRow } from '../lib/rucuImport'
import { Badge, Card, Empty, ErrorNote, Pager, STATUS_TONE, Table, askReason } from '../components/ui'
import { universityName } from '../config/site'
import { useAuth } from '../auth/AuthContext'

const PAGE_SIZE = 25

type Req = {
  id: string
  university: string
  method: string
  registration_number: string
  form_four_index_number: string
  full_name_provided: string
  status: string
  created_at: string
  rejection_reason: string | null
}

type RucuStudent = {
  id: string
  registration_number: string
  last_name: string
  full_name: string
  programme: string | null
  year_of_study: string | null
  form_four_index_number: string | null
}

export default function AdminStudents() {
  const { role } = useAuth()
  const canManageRegister = role === 'SUPER_ADMIN'
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const list = useAdminList<Req>(
    (from, to) =>
      supabase
        .from('verification_requests')
        .select(
          'id,university,method,registration_number,form_four_index_number,full_name_provided,status,created_at,rejection_reason',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range(from, to),
    PAGE_SIZE,
  )

  const review = async (id: string, decision: 'VERIFIED' | 'REJECTED') => {
    setActionError('')

    const reason =
      decision === 'REJECTED'
        ? askReason('Reason for rejection (this is shown to the student):')
        : undefined

    if (decision === 'REJECTED' && reason === undefined) return

    setBusyId(id)

    const { error } = await supabase.rpc('review_verification', {
      p_request_id: id,
      p_decision: decision,
      p_reason: reason ?? null,
    })

    setBusyId(null)

    if (error) {
      setActionError(describeError(error))
      return
    }

    list.reload()
  }

  const [importMsg, setImportMsg] = useState('')
  const [importErr, setImportErr] = useState('')
  const [importing, setImporting] = useState(false)

  const onFile = (file: File) => {
    setImportMsg('')
    setImportErr('')
    setImporting(true)

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,

      complete: async (res) => {
        const rows = res.data
          .map(normalizeRucuStudentRow)
          .filter((row) => Object.values(row).some((value) => Boolean(value)))

        const hasRegistration = rows.some((row) => row.registration_number)
        const hasLastName = rows.some((row) => row.last_name)
        const hasFullName = rows.some((row) => row.full_name)

        if (!hasRegistration || !hasLastName || !hasFullName) {
          setImporting(false)
          setImportErr(
            'CSV needs registration number, last name, and full name (or first and last name) columns.',
          )
          return
        }

        const invalidRows = rows
          .map((row, index) => ({ row, line: index + 2 }))
          .filter(
            ({ row }) =>
              !row.registration_number || !row.last_name || !row.full_name,
          )

        if (rows.length === 0 || invalidRows.length > 0) {
          setImporting(false)

          setImportErr(
            invalidRows.length > 0
              ? `Missing registration number, last name, or full name on CSV row(s): ${invalidRows
                  .map(({ line }) => line)
                  .join(', ')}`
              : 'No usable student rows found.',
          )

          return
        }

        const { data, error } = await supabase.rpc('import_rucu_students', {
          p_rows: rows,
        })

        setImporting(false)

        if (error) {
          setImportErr(describeError(error))
          return
        }

        setImportMsg(
          `Imported or updated ${Number(data ?? rows.length)} register record(s).`,
        )

        rucuList.reload()
      },

      error: () => {
        setImporting(false)
        setImportErr('That file could not be read as CSV.')
      },
    })
  }

  const [rucuSearch, setRucuSearch] = useState('')
  const [rucuPage, setRucuPage] = useState(0)

  const rucuList = useAdminList<RucuStudent>(
    (from, to) => {
      if (!canManageRegister) return Promise.resolve({ data: [], error: null, count: 0 })
      let query = supabase
        .from('rucu_students')
        .select(
          'id,registration_number,last_name,full_name,programme,year_of_study,form_four_index_number',
          { count: 'exact' },
        )
        .order('full_name', { ascending: true })
        .range(from, to)

      const search = rucuSearch.trim()

      if (search) {
        const escaped = search.replace(/[%_,]/g, '')
        query = query.or(
          `registration_number.ilike.%${escaped}%,full_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,programme.ilike.%${escaped}%`,
        )
      }

      return query
    },
    PAGE_SIZE,
  )

  const rucuPageChange = (page: number) => {
    setRucuPage(page)
    rucuList.setPage(page)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Students</h1>

      {canManageRegister && <Card
        title="RUCU student register"
        hint="The student register is restricted to super administrators."
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total students
            </p>
            <p className="mt-1 text-2xl font-bold text-navy">
              {rucuList.count ?? 0}
            </p>
          </div>

          <div className="rounded-lg border bg-slate-50 p-4 sm:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Search register
            </label>

            <input
              type="search"
              className="input mt-1"
              placeholder="Registration number, student name or programme"
              value={rucuSearch}
              onChange={(e) => {
                setRucuSearch(e.target.value)
                setRucuPage(0)
                rucuList.setPage(0)
              }}
            />
          </div>
        </div>

        <ErrorNote error={rucuList.error} onRetry={rucuList.reload} />

        {rucuList.loading ? (
          <p className="text-slate-500">Loading RUCU register…</p>
        ) : rucuList.rows.length === 0 ? (
          <Empty>No RUCU students found.</Empty>
        ) : (
          <>
            <Table
              head={[
                'Registration No.',
                'Student',
                'Programme',
                'Year',
                'Form Four Index',
              ]}
            >
              {rucuList.rows.map((student) => (
                <tr key={student.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {student.registration_number}
                  </td>

                  <td className="py-2 pr-3">
                    {student.full_name}
                  </td>

                  <td className="py-2 pr-3">
                    {student.programme || '—'}
                  </td>

                  <td className="py-2 pr-3">
                    {student.year_of_study || '—'}
                  </td>

                  <td className="py-2 pr-3 font-mono text-xs">
                    {student.form_four_index_number || '—'}
                  </td>
                </tr>
              ))}
            </Table>

            {rucuList.pageable && (
              <Pager
                page={rucuPage}
                count={rucuList.count}
                pageSize={PAGE_SIZE}
                onPage={rucuPageChange}
              />
            )}
          </>
        )}

        <div className="mt-5 border-t pt-4">
          <p className="mb-2 text-sm font-medium text-slate-700">
            Import / update RUCU register
          </p>

          <input
            type="file"
            accept=".csv,text/csv"
            className="input"
            disabled={importing}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />

          {importing && (
            <p className="mt-2 text-sm text-slate-500">
              Importing…
            </p>
          )}

          {importMsg && (
            <p className="mt-2 text-sm text-green-700">
              {importMsg}
            </p>
          )}

          <ErrorNote error={importErr} />
        </div>
      </Card>}

      <Card
        title="Verification requests"
        hint="Approving a request sets the student's status to VERIFIED. Identity details then become staff-managed and can no longer be edited by the student."
      >
        <ErrorNote
          error={list.error || actionError}
          onRetry={list.reload}
        />

        {list.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : list.rows.length === 0 ? (
          <Empty>No verification requests yet.</Empty>
        ) : (
          <>
            <Table
              head={[
                'Student',
                'University',
                'Reg no.',
                'Method',
                'Status',
                'Submitted',
                'Action',
              ]}
            >
              {list.rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3">
                    {r.full_name_provided}
                  </td>

                  <td className="py-2 pr-3">
                    {universityName(r.university)}
                  </td>

                  <td className="py-2 pr-3 font-mono text-xs">
                    {r.registration_number}
                  </td>

                  <td className="py-2 pr-3">
                    {r.method === 'RUCU_AUTO'
                      ? 'Auto-matched'
                      : 'Manual'}
                  </td>

                  <td className="py-2 pr-3">
                    <Badge tone={STATUS_TONE[r.status]}>
                      {r.status}
                    </Badge>

                    {r.rejection_reason && (
                      <p className="mt-1 text-xs text-slate-500">
                        {r.rejection_reason}
                      </p>
                    )}
                  </td>

                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>

                  <td className="py-2 pr-3">
                    {r.status === 'PENDING' ? (
                      <div className="flex gap-2">
                        <button
                          className="btn-primary px-3 py-1 text-xs"
                          disabled={busyId === r.id}
                          onClick={() =>
                            void review(r.id, 'VERIFIED')
                          }
                        >
                          Approve
                        </button>

                        <button
                          className="btn border border-red-300 px-3 py-1 text-xs text-red-700"
                          disabled={busyId === r.id}
                          onClick={() =>
                            void review(r.id, 'REJECTED')
                          }
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">
                        Reviewed
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>

            {list.pageable && (
              <Pager
                page={list.page}
                count={list.count}
                pageSize={PAGE_SIZE}
                onPage={list.setPage}
              />
            )}
          </>
        )}
      </Card>
    </div>
  )
}