import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { site } from '../config/site'
import { useAuth } from '../auth/AuthContext'
export function Logo({ light = false }: { light?: boolean }) {
  return <Link to="/" className="flex items-center gap-2" aria-label={site.name}>
    {site.logoUrl ? <img src={site.logoUrl} alt={site.name} className="h-9" /> :
      <span className="grid h-9 w-9 place-items-center rounded-lg border-2 border-dashed border-slate-400 text-[9px] text-slate-400" title="Logo placeholder">LOGO</span>}
    <span className={`text-sm font-extrabold tracking-wide ${light ? 'text-white' : 'text-navy'}`}>{site.name}</span></Link>
}
const links = [['/', 'Home'], ['/about', 'About'], ['/how-it-works', 'How It Works'], ['/register', 'Apply'], ['/contact', 'Contact']]
export default function Layout() {
  const [open, setOpen] = useState(false); const { session, role, signOut } = useAuth(); const nav = useNavigate()
  const home = role === 'STUDENT' ? '/student/dashboard' : '/admin'
  return <div className="flex min-h-screen flex-col">
    <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
      <Logo />
      <nav className="hidden items-center gap-6 text-sm md:flex" aria-label="Main">
        {links.map(([to, l]) => <NavLink key={to} to={to} end className={({ isActive }) => isActive ? 'font-semibold text-brand' : 'text-slate-600 hover:text-navy'}>{l}</NavLink>)}
        {session ? <><Link to={home} className="btn-blue">Dashboard</Link><button className="btn-outline" onClick={async () => { await signOut(); nav('/') }}>Logout</button></>
          : <><Link to="/login" className="btn-outline">Login</Link><Link to="/register" className="btn-primary">Register</Link></>}
      </nav>
      <button className="rounded-lg p-2 md:hidden" aria-expanded={open} aria-label="Toggle menu" onClick={() => setOpen(!open)}>{open ? '✕' : '☰'}</button></div>
      {open && <nav className="space-y-1 border-t bg-white px-4 py-3 md:hidden" aria-label="Mobile">
        {links.map(([to, l]) => <Link key={to} to={to} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-3 text-slate-700 hover:bg-slate-100">{l}</Link>)}
        <div className="flex gap-2 pt-2">{session ? <Link to={home} onClick={() => setOpen(false)} className="btn-blue flex-1">Dashboard</Link>
          : <><Link to="/login" onClick={() => setOpen(false)} className="btn-outline flex-1">Login</Link><Link to="/register" onClick={() => setOpen(false)} className="btn-primary flex-1">Register</Link></>}</div></nav>}
    </header>
    <main className="flex-1"><Outlet /></main>
    <footer className="bg-navy text-slate-200"><div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-2">
      <div><Logo light /><p className="mt-2 text-sm">{site.tagline}</p></div>
      <ul className="grid grid-cols-2 gap-2 text-sm">{[...links, ['/verify', 'Verify Application'], ['/privacy', 'Privacy Policy'], ['/terms', 'Terms & Conditions']].map(([to, l]) => <li key={to}><Link className="hover:text-white" to={to}>{l}</Link></li>)}</ul></div>
      <p className="border-t border-white/10 py-4 text-center text-xs">{site.copyright} · {site.developer}</p></footer></div>
}
