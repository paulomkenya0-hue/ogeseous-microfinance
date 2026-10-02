import { useState } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { useAdminList } from '../lib/useAdminList'
import { describeError } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Pager, STATUS_TONE, Table, askReason } from '../components/ui'
import { universityName } from '../config/site'

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

export default function AdminStudents() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const list = useAdminList<Req>(
    (from, to) =>
      supabase
        .from('verification_requests')
        .select('id,university,method,registration_number,form_four_index_number,full_name_provided,status,created_at,rejection_reason', {
          count: 'exact',
        })
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
      // 011 refuses to re-decide a request that has already been reviewed, so this message is
      // worth reading rather than a generic failure.
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
        const required = ['form_four_index_number', 'registration_number', 'last_name', 'full_name']
        const headers = res.meta.fields ?? []
        const missing = required.filter((h) => !headers.includes(h))
        if (missing.length > 0) {
          setImporting(false)
          setImportErr(`CSV is missing required columns: ${missing.join(', ')}`)
          return
        }

        const rows = res.data.filter((r) => r.form_four_index_number && r.registration_number)
        if (rows.length === 0) {
          setImporting(false)
          setImportErr('No usable rows found. Every row needs a Form Four Index Number and a Registration Number.')
          return
        }

        const { data, error } = await supabase.rpc('import_rucu_students', { p_rows: rows })
        setImporting(false)
        if (error) {
          setImportErr(describeError(error))
          return
        }
        setImportMsg(`Imported or updated ${Number(data ?? rows.length)} register record(s).`)
      },
      error: () => {
        setImporting(false)
        setImportErr('That file could not be read as CSV.')
      },
    })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Students</h1>

      <Card
        title="RUCU student register"
        hint="CSV columns: form_four_index_number, registration_number, last_name, full_name. Existing rows are updated, not duplicated."
      >
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
        {importing && <p className="mt-2 text-sm text-slate-500">Importing…</p>}
        {importMsg && <p className="mt-2 text-sm text-green-700">{importMsg}</p>}
        <ErrorNote error={importErr} />
      </Card>

      <Card
        title="Verification requests"
        hint="Approving a request sets the student's status to VERIFIED. Identity details then become staff-managed and can no longer be edited by the student."
      >
        <ErrorNote error={list.error || actionError} onRetry={list.reload} />

        {list.loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : list.rows.length === 0 ? (
          <Empty>No verification requests yet.</Empty>
        ) : (
          <>
            <Table
              head={['Student', 'University', 'Reg no.', 'Method', 'Status', 'Submitted', 'Action']}
            >
              {list.rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3">{r.full_name_provided}</td>
                  <td className="py-2 pr-3">{universityName(r.university)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.registration_number}</td>
                  <td className="py-2 pr-3">{r.method === 'RUCU_AUTO' ? 'Auto-matched' : 'Manual'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    {r.rejection_reason && (
                      <p className="mt-1 text-xs text-slate-500">{r.rejection_reason}</p>
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
                          onClick={() => void review(r.id, 'VERIFIED')}
                        >
                          Approve
                        </button>
                        <button
                          className="btn border border-red-300 px-3 py-1 text-xs text-red-700"
                          disabled={busyId === r.id}
                          onClick={() => void review(r.id, 'REJECTED')}
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Reviewed</span>
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