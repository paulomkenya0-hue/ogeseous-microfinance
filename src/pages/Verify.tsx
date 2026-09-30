import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { uploadVerificationFile } from '../lib/storage'
import { useAuth } from '../auth/AuthContext'
import { site } from '../config/site'

type Match = { id: string; full_name: string; registration_number: string; form_four_index_number: string }
const MAX_MB = 5
const okFile = (f: File | null) => !!f && f.size <= MAX_MB * 1024 * 1024

export default function Verify() {
  const { session } = useAuth()
  const nav = useNavigate()
  const [university, setUniversity] = useState<'' | 'RUCU' | 'MKWAWA' | 'IU'>('')
  const [index, setIndex] = useState(''); const [reg, setReg] = useState(''); const [lastName, setLastName] = useState('')
  const [match, setMatch] = useState<Match | null>(null); const [searchMsg, setSearchMsg] = useState('')
  const [manualName, setManualName] = useState('')
  const [certificate, setCertificate] = useState<File | null>(null)
  const [idDoc, setIdDoc] = useState<File | null>(null)
  const [photo, setPhoto] = useState<File | null>(null)
  const [err, setErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [submitErr, setSubmitErr] = useState('')

  const search = async () => {
    setSearchMsg(''); setMatch(null)
    if (!index.trim()) return setSearchMsg('Enter your Form Four Index Number.')
    if (!reg.trim() && !lastName.trim()) return setSearchMsg('Also enter your Registration Number or Last Name.')
    const { data, error } = await supabase.rpc('search_rucu_student', { p_index: index, p_registration: reg || null, p_lastname: lastName || null })
    if (error) return setSearchMsg('Search failed. Please try again.')
    const row = Array.isArray(data) ? data[0] : data
    if (!row) return setSearchMsg('No matching record found in the RUCU database. Check your details or contact OGESEOUS.')
    setMatch(row)
  }

  const validateDocs = () => {
    const x: Record<string, string> = {}
    if (!okFile(certificate)) x.certificate = `Upload your Form Four certificate (max ${MAX_MB}MB)`
    if (!okFile(idDoc)) x.idDoc = `Upload an additional identity document (max ${MAX_MB}MB)`
    if (!okFile(photo)) x.photo = `Upload a passport photo (max ${MAX_MB}MB)`
    if (university === 'RUCU' && !match) x.rucu = 'Confirm your matched record before continuing'
    if (university !== 'RUCU' && manualName.trim().length < 3) x.manualName = 'Enter your full name'
    if (university !== 'RUCU' && !reg.trim()) x.reg = 'Enter your registration number'
    if (university !== 'RUCU' && !index.trim()) x.index = 'Enter your Form Four Index Number'
    setErr(x); return Object.keys(x).length === 0
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setSubmitErr('')
    if (!validateDocs() || !session) return
    setBusy(true)
    try {
      const uid = session.user.id
      const [certUrl, idUrl, photoUrl] = await Promise.all([
        uploadVerificationFile(uid, 'certificate', certificate!),
        uploadVerificationFile(uid, 'id', idDoc!),
        uploadVerificationFile(uid, 'passport', photo!),
      ])
      const { error } = await supabase.rpc('submit_verification', {
        p_university: university,
        p_method: university === 'RUCU' ? 'RUCU_AUTO' : 'MANUAL',
        p_registration: university === 'RUCU' ? match!.registration_number : reg,
        p_index: university === 'RUCU' ? match!.form_four_index_number : index,
        p_full_name: university === 'RUCU' ? match!.full_name : manualName,
        p_rucu_student_id: university === 'RUCU' ? match!.id : null,
        p_certificate_url: certUrl, p_id_document_url: idUrl, p_passport_url: photoUrl,
      })
      if (error) throw error
      setDone(true)
    } catch (e: any) {
      setSubmitErr(e?.message?.includes('one_open_request') || e?.code === '23505'
        ? 'You already have a verification request pending or approved.' : 'Could not submit. Please try again.')
    } finally { setBusy(false) }
  }

  if (done) return <div className="mx-auto max-w-lg px-4 py-16 text-center">
    <div className="card"><h1 className="text-xl font-bold text-navy">Verification submitted</h1>
      <p className="mt-2 text-slate-600">Your documents are under review. This does not mean automatic approval — OGESEOUS staff will verify your details.</p>
      <button className="btn-blue mt-4" onClick={() => nav('/student/dashboard')}>Back to dashboard</button></div></div>

  const FileRow = ({ label, val, setVal, error }: { label: string; val: File | null; setVal: (f: File | null) => void; error?: string }) =>
    <label className="block text-sm font-medium">{label} <span className="font-normal text-slate-400">(max {MAX_MB}MB)</span>
      <input type="file" accept="image/*,.pdf" className="input mt-1" onChange={e => setVal(e.target.files?.[0] ?? null)} />
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}</label>

  return <div className="mx-auto max-w-2xl px-4 py-10">
    <h1 className="mb-1 text-2xl font-bold text-navy">Student Verification</h1>
    <p className="mb-6 text-sm text-slate-600">This does not guarantee loan approval; it confirms your identity as a student at a supported university.</p>

    <div className="card mb-6"><label className="block text-sm font-medium">University
      <select className="input mt-1" value={university} onChange={e => { setUniversity(e.target.value as any); setMatch(null); setSearchMsg('') }}>
        <option value="">Select your university</option>
        {site.universities.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}
      </select></label></div>

    {university === 'RUCU' && <div className="card mb-6 space-y-3">
      <p className="text-sm text-slate-600">Search the RUCU student database to confirm your record.</p>
      <label className="block text-sm font-medium">Form Four Index Number<input className="input mt-1" value={index} onChange={e => setIndex(e.target.value)} /></label>
      <label className="block text-sm font-medium">Registration Number<input className="input mt-1" value={reg} onChange={e => setReg(e.target.value)} /></label>
      <label className="block text-sm font-medium">Last Name<input className="input mt-1" value={lastName} onChange={e => setLastName(e.target.value)} /></label>
      <button type="button" className="btn-outline" onClick={search}>Search</button>
      {searchMsg && <p className="text-sm text-red-600">{searchMsg}</p>}
      {match && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-800">
        Found: <b>{match.full_name}</b> — Reg No. {match.registration_number}, Index {match.form_four_index_number}.
        <label className="mt-2 flex items-center gap-2"><input type="checkbox" onChange={e => setMatch(e.target.checked ? match : null)} defaultChecked /> This is me — confirm identity</label></div>}
      {err.rucu && <p className="text-xs text-red-600">{err.rucu}</p>}</div>}

    {(university === 'MKWAWA' || university === 'IU') && <div className="card mb-6 space-y-3">
      <p className="text-sm text-slate-600">Manual verification: enter your details for staff review.</p>
      <label className="block text-sm font-medium">Full Name<input className="input mt-1" value={manualName} onChange={e => setManualName(e.target.value)} />{err.manualName && <span className="text-xs text-red-600">{err.manualName}</span>}</label>
      <label className="block text-sm font-medium">Registration Number<input className="input mt-1" value={reg} onChange={e => setReg(e.target.value)} />{err.reg && <span className="text-xs text-red-600">{err.reg}</span>}</label>
      <label className="block text-sm font-medium">Form Four Index Number<input className="input mt-1" value={index} onChange={e => setIndex(e.target.value)} />{err.index && <span className="text-xs text-red-600">{err.index}</span>}</label></div>}

    {university && <form onSubmit={submit} className="card space-y-4">
      <h2 className="font-semibold text-navy">Documents</h2>
      <FileRow label="Form Four Certificate" val={certificate} setVal={setCertificate} error={err.certificate} />
      <FileRow label="Additional Identity Document (NIDA, Voter ID, or School ID)" val={idDoc} setVal={setIdDoc} error={err.idDoc} />
      <FileRow label="Passport Photo" val={photo} setVal={setPhoto} error={err.photo} />
      {submitErr && <p role="alert" className="text-sm text-red-600">{submitErr}</p>}
      <button className="btn-primary w-full" disabled={busy}>{busy ? 'Submitting…' : 'Submit for Verification'}</button></form>}
  </div>
}
