import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  uploadVerificationFile,
  discardUploads,
  fileProblem,
  DOC_LABELS,
  MAX_BYTES,
  type DocKind,
} from '../lib/storage'
import { useAuth } from '../auth/AuthContext'
import { describeError } from '../lib/api'
import { hasErrors, type Errors } from '../lib/validate'
import { site } from '../config/site'

type Match = { id: string; full_name: string; registration_number: string; form_four_index_number: string }
type Uni = '' | 'RUCU' | 'MKWAWA' | 'IU'

export default function Verify() {
  const { session } = useAuth()
  const nav = useNavigate()

  const [university, setUniversity] = useState<Uni>('')
  const [index, setIndex] = useState('')
  const [reg, setReg] = useState('')
  const [lastName, setLastName] = useState('')
  const [match, setMatch] = useState<Match | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState<Errors & { info?: string }>({})

  const [manualName, setManualName] = useState('')
  const [files, setFiles] = useState<Record<DocKind, File | null>>({ certificate: null, id: null, passport: null })

  const [err, setErr] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [done, setDone] = useState(false)

  const pick = (kind: DocKind) => (f: File | null) => {
    setFiles((prev) => ({ ...prev, [kind]: f }))
    setErr((prev) => ({ ...prev, [kind]: '' }))
  }

  const search = async () => {
    setSearchMsg({})
    setMatch(null)
    if (!index.trim()) return setSearchMsg({ index: 'Enter your Form Four Index Number.' })
    if (!reg.trim() && !lastName.trim()) {
      return setSearchMsg({ reg: 'Also enter your Registration Number or your Last Name.' })
    }

    setSearching(true)
    const { data, error } = await supabase.rpc('search_rucu_student', {
      p_index: index.trim(),
      p_registration: reg.trim() || null,
      p_lastname: lastName.trim() || null,
    })
    setSearching(false)

    if (error) return setSearchMsg({ info: describeError(error) })
    const row = (Array.isArray(data) ? data[0] : data) as Match | undefined
    if (!row) {
      return setSearchMsg({
        info: 'No matching record found in the RUCU database. Check your details, or contact OGESEOUS if you believe this is wrong.',
      })
    }
    setMatch(row)
  }

  const validate = (): Errors => {
    const next: Errors = {}
    for (const kind of ['certificate', 'id', 'passport'] as DocKind[]) {
      const problem = fileProblem(files[kind])
      if (problem) next[kind] = problem
    }
    if (university === 'RUCU' && !match) next.rucu = 'Confirm the record we found before continuing'
    if (university && university !== 'RUCU') {
      if (manualName.trim().length < 3) next.manualName = 'Enter your full name'
      if (!reg.trim()) next.reg = 'Enter your registration number'
      if (!index.trim()) next.index = 'Enter your Form Four Index Number'
    }
    return next
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitErr('')
    if (!session) return

    const next = validate()
    setErr(next)
    if (hasErrors(next)) return

    setBusy(true)
    const uploaded: string[] = []
    try {
      // Uploaded before the RPC, because submit_verification() now checks that each path really
      // exists in this student's folder. The old order could leave the request created while the
      // document was orphaned in the bucket.
      const paths = await Promise.all(
        (['certificate', 'id', 'passport'] as DocKind[]).map(async (kind) => {
          const p = await uploadVerificationFile(session.user.id, kind, files[kind]!)
          uploaded.push(p)
          return p
        }),
      )

      const { error } = await supabase.rpc('submit_verification', {
        p_university: university,
        p_method: university === 'RUCU' ? 'RUCU_AUTO' : 'MANUAL',
        // For RUCU these are taken from the register row, not from the fields on screen, so the
        // student's own typing cannot contradict what the register says.
        p_registration: university === 'RUCU' ? match!.registration_number : reg.trim(),
        p_index: university === 'RUCU' ? match!.form_four_index_number : index.trim(),
        p_full_name: university === 'RUCU' ? match!.full_name : manualName.trim(),
        p_rucu_student_id: university === 'RUCU' ? match!.id : null,
        p_certificate_url: paths[0],
        p_id_document_url: paths[1],
        p_passport_url: paths[2],
      })
      if (error) throw new Error(error.message)

      setDone(true)
    } catch (err0) {
      // Nothing references an upload that did not lead to a request. Leaving three documents in
      // the bucket for a submission that failed is how a student's private files accumulate.
      await discardUploads(session.user.id, uploaded)
      setSubmitErr(describeError(err0))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">Verification submitted</h1>
          <p className="mt-2 text-slate-600">
            Your documents are with OGESEOUS staff for review. This is not automatic approval — a
            member of staff will confirm your details, and you will see the outcome on your
            dashboard.
          </p>
          <button className="btn-blue mt-4" onClick={() => nav('/student/dashboard')}>
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-navy">Student Verification</h1>
      <p className="mb-6 text-sm text-slate-600">
        This confirms you are a student at a supported university. It does not guarantee a loan.
      </p>

      <div className="card mb-6">
        <label className="block text-sm font-medium">
          University
          <select
            className="input mt-1"
            value={university}
            onChange={(e) => {
              setUniversity(e.target.value as Uni)
              setMatch(null)
              setSearchMsg({})
            }}
          >
            <option value="">Select your university</option>
            {site.universities.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {university === 'RUCU' && (
        <div className="card mb-6 space-y-3">
          <p className="text-sm text-slate-600">
            We will check your details against the RUCU student register.
          </p>
          <label className="block text-sm font-medium">
            Form Four Index Number
            <input className="input mt-1" value={index} onChange={(e) => setIndex(e.target.value)} />
            {searchMsg.index && <span className="text-xs text-red-600">{searchMsg.index}</span>}
          </label>
          <label className="block text-sm font-medium">
            Registration Number
            <input className="input mt-1" value={reg} onChange={(e) => setReg(e.target.value)} />
            {searchMsg.reg && <span className="text-xs text-red-600">{searchMsg.reg}</span>}
          </label>
          <label className="block text-sm font-medium">
            Last Name
            <input className="input mt-1" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>

          <button type="button" className="btn-outline" disabled={searching} onClick={() => void search()}>
            {searching ? 'Searching…' : 'Search the register'}
          </button>

          {searchMsg.info && (
            <p role="alert" className="text-sm text-red-600">
              {searchMsg.info}
            </p>
          )}

          {match && (
            <div className="rounded-lg bg-green-50 p-3 text-sm text-green-800">
              <p>
                Found: <b>{match.full_name}</b> — registration {match.registration_number}, index{' '}
                {match.form_four_index_number}.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!match}
                  onChange={(e) => setMatch(e.target.checked ? match : null)}
                />
                This is me — confirm
              </label>
            </div>
          )}
          {err.rucu && <p className="text-xs text-red-600">{err.rucu}</p>}
        </div>
      )}

      {(university === 'MKWAWA' || university === 'IU') && (
        <div className="card mb-6 space-y-3">
          <p className="text-sm text-slate-600">
            We do not hold a register for this university, so your details are checked by staff.
          </p>
          <label className="block text-sm font-medium">
            Full name
            <input className="input mt-1" value={manualName} onChange={(e) => setManualName(e.target.value)} />
            {err.manualName && <span className="text-xs text-red-600">{err.manualName}</span>}
          </label>
          <label className="block text-sm font-medium">
            Registration number
            <input className="input mt-1" value={reg} onChange={(e) => setReg(e.target.value)} />
            {err.reg && <span className="text-xs text-red-600">{err.reg}</span>}
          </label>
          <label className="block text-sm font-medium">
            Form Four Index Number
            <input className="input mt-1" value={index} onChange={(e) => setIndex(e.target.value)} />
            {err.index && <span className="text-xs text-red-600">{err.index}</span>}
          </label>
        </div>
      )}

      {university && (
        <form onSubmit={submit} className="card space-y-4" noValidate>
          <h2 className="font-semibold text-navy">Documents</h2>
          <p className="-mt-2 text-xs text-slate-500">
            JPEG, PNG, WebP, HEIC or PDF, up to {MAX_BYTES / 1024 / 1024}MB each. Only OGESEOUS staff
            can read these, and you can delete them from your dashboard.
          </p>

          {(['certificate', 'id', 'passport'] as DocKind[]).map((kind) => (
            <label key={kind} className="block text-sm font-medium">
              {DOC_LABELS[kind]}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                className="input mt-1"
                onChange={(e) => pick(kind)(e.target.files?.[0] ?? null)}
              />
              {files[kind] && (
                <span className="mt-1 block text-xs text-slate-500">
                  {files[kind]!.name} ({(files[kind]!.size / 1024).toFixed(0)}KB)
                </span>
              )}
              {err[kind] && (
                <span role="alert" className="text-xs text-red-600">
                  {err[kind]}
                </span>
              )}
            </label>
          ))}

          {submitErr && (
            <p role="alert" className="text-sm text-red-600">
              {submitErr}
            </p>
          )}

          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit for verification'}
          </button>
        </form>
      )}
    </div>
  )
}
