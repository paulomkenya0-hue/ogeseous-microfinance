import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { site } from '../config/site'
import { isEmail, isPhone } from '../lib/validate'
const Sec = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="mx-auto max-w-6xl px-4 py-12"><h2 className="mb-6 text-2xl font-bold text-navy">{title}</h2>{children}</section>
export function Home() {
  const feats = [['Easy Application', 'Register and apply online from your account.'], ['Secure & Reliable', 'Accounts are protected with authenticated access.'],
    ['Student Focused', 'Services designed around the needs of university students.'], ['Transparent Process', 'Clear steps, and you can track your application status.']]
  const steps = [['01', 'Register', 'Create your student account.'], ['02', 'Verify', 'Provide the required student and identity information.'],
    ['03', 'Apply', 'Complete the loan application and submit the required documents.'], ['04', 'Track', 'Monitor your application and loan status from your account.']]
  return <>
    <section className="bg-gradient-to-br from-navy to-brand text-white"><div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 md:grid-cols-2 md:py-24">
      <div><h1 className="text-4xl font-extrabold leading-tight md:text-5xl">Student Loans for a Brighter Future</h1>
        <p className="mt-4 text-blue-100">OGESEOUS Microfinance provides student-focused financial support designed to help eligible university students pursue their education.</p>
        <div className="mt-6 flex flex-wrap gap-3"><Link to="/register" className="btn-primary">Apply for a Loan</Link><a href="#why" className="btn border border-white/60 text-white hover:bg-white/10">Learn More</a></div></div>
      <div className="grid h-56 place-items-center rounded-2xl border-2 border-dashed border-white/40 text-sm text-blue-100 md:h-72">Image placeholder</div></div></section>
    <div id="why"><Sec title="Why Choose OGESEOUS"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{feats.map(([t, d]) => <div className="card" key={t}><h3 className="font-semibold text-navy">{t}</h3><p className="mt-2 text-sm text-slate-600">{d}</p></div>)}</div></Sec></div>
    <Sec title="Supported Universities"><div className="grid gap-4 sm:grid-cols-3">{site.universities.map(u => <div className="card text-center" key={u.code}>
      <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full border-2 border-dashed border-slate-300 text-[10px] text-slate-400">LOGO</div><p className="font-semibold text-navy">{u.name}</p><p className="text-xs text-slate-500">{u.code}</p></div>)}</div>
      <p className="mt-4 text-sm text-slate-600">Student eligibility is subject to verification and OGESEOUS Microfinance requirements.</p></Sec>
    <Sec title="How It Works"><ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{steps.map(([n, t, d]) => <li className="card" key={n}><span className="text-3xl font-extrabold text-accent">{n}</span><h3 className="mt-1 font-semibold text-navy">{t}</h3><p className="text-sm text-slate-600">{d}</p></li>)}</ol></Sec></>
}
export const HowItWorks = () => <Sec title="How It Works"><p className="mb-4 text-slate-600">Register, verify, apply and track. Approval is never automatic; every application is reviewed.</p><Home /></Sec>
export const About = () => <Sec title="About OGESEOUS Microfinance"><div className="space-y-4">
  {[['Our Purpose', 'To provide student-focused financial support for eligible university students.'], ['Student-focused financial services', 'Services are designed for students of RUCU, Mkwawa University College and Iringa University, subject to verification.'],
    ['Our Process', 'Register, verify, apply and track your application from your account.']].map(([t, d]) => <div className="card" key={t}><h3 className="font-semibold text-navy">{t}</h3><p className="mt-1 text-slate-600">{d}</p></div>)}
  <div className="card"><h3 className="font-semibold text-navy">Contact Information</h3><Info /></div></div></Sec>
const Info = () => <dl className="mt-2 grid gap-1 text-sm">{[['Phone', site.contact.phone], ['Email', site.contact.email], ['Address', site.contact.address], ['Working hours', site.contact.hours]].map(([k, v]) => <div key={k}><dt className="inline font-medium">{k}: </dt><dd className="inline text-slate-600">{v || 'To be provided by OGESEOUS'}</dd></div>)}</dl>
export function Contact() {
  const [f, setF] = useState({ name: '', email: '', phone: '', subject: '', message: '' }); const [err, setErr] = useState<Record<string, string>>({}); const [done, setDone] = useState(false)
  const submit = (e: FormEvent) => { e.preventDefault(); const x: Record<string, string> = {}
    if (f.name.trim().length < 2) x.name = 'Enter your full name'; if (!isEmail(f.email)) x.email = 'Enter a valid email'; if (f.phone && !isPhone(f.phone)) x.phone = 'Enter a valid phone number'
    if (f.subject.trim().length < 3) x.subject = 'Enter a subject'; if (f.message.trim().length < 10) x.message = 'Message must be at least 10 characters'
    setErr(x); setDone(Object.keys(x).length === 0) }
  const fld = (k: keyof typeof f, label: string, area = false) => <label className="block text-sm font-medium">{label}
    {area ? <textarea rows={5} className="input mt-1" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /> : <input className="input mt-1" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />}
    {err[k] && <span role="alert" className="text-xs text-red-600">{err[k]}</span>}</label>
  return <Sec title="Contact Us"><div className="grid gap-6 md:grid-cols-2"><div className="card"><h3 className="font-semibold text-navy">Our details</h3><Info /></div>
    <form onSubmit={submit} className="card space-y-3" noValidate>{fld('name', 'Full Name')}{fld('email', 'Email')}{fld('phone', 'Phone')}{fld('subject', 'Subject')}{fld('message', 'Message', true)}
      <button className="btn-blue w-full">Send message</button>
      {done && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Your details are valid, but message sending is not configured yet. No message was delivered.</p>}</form></div></Sec>
}
export const Legal = ({ title }: { title: string }) => <Sec title={title}><div className="card text-slate-600">This page is a placeholder. The official {title} text will be provided by OGESEOUS Microfinance.</div></Sec>
