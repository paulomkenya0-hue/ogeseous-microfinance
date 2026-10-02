import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { site } from '../config/site'
import { useAuth } from '../auth/AuthContext'

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label={site.name}>
      {site.logoUrl ? (
        <img src={site.logoUrl} alt="" className="h-9" />
      ) : (
        <span
          className="grid h-9 w-9 place-items-center rounded-lg border-2 border-dashed border-slate-400 text-[9px] text-slate-400"
          title="Logo placeholder — set site.logoUrl in src/config/site.ts"
        >
          LOGO
        </span>
      )}
      <span className={`text-sm font-extrabold tracking-wide ${light ? 'text-white' : 'text-navy'}`}>
        {site.name}
      </span>
    </Link>
  )
}

const links: [string, string][] = [
  ['/', 'Home'],
  ['/about', 'About'],
  ['/how-it-works', 'How It Works'],
  ['/register', 'Apply'],
  ['/track', 'Track Application'],
  ['/contact', 'Contact'],
]

const footerLinks: [string, string][] = [
  ...links,
  ['/verify', 'Verify Application'],
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms & Conditions'],
]

export default function Layout() {
  const [open, setOpen] = useState(false)
  const { session, role, signOut } = useAuth()
  const nav = useNavigate()

  /**
   * The old expression was `role === 'STUDENT' ? '/student/dashboard' : '/admin'`, which sent
   * signed-in users whose role had not loaded yet to /admin — and ProtectedRoute then bounced
   * them straight back. Send them nowhere useful until the role is actually known.
   */
  const home = !session ? '/login' : role === 'STUDENT' ? '/dashboard' : role ? '/admin' : '/'

  const signOutAndGo = async () => {
    await signOut()
    nav('/')
  }

  const close = () => setOpen(false)

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm md:flex" aria-label="Main">
            {links.map(([to, l]) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  isActive ? 'font-semibold text-brand' : 'text-slate-600 hover:text-navy'
                }
              >
                {l}
              </NavLink>
            ))}
            {session ? (
              <>
                <Link className="btn-blue" to={home}>
                  Dashboard
                </Link>
                <button className="btn-outline" onClick={() => void signOutAndGo()}>
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link className="btn-outline" to="/login">
                  Login
                </Link>
                <Link className="btn-primary" to="/register">
                  Register
                </Link>
              </>
            )}
          </nav>
          <button
            className="rounded-lg p-2 md:hidden"
            aria-expanded={open}
            aria-label="Toggle menu"
            onClick={() => setOpen(!open)}
          >
            {open ? '✕' : '☰'}
          </button>
        </div>

        {open && (
          <nav className="space-y-1 border-t bg-white px-4 py-3 md:hidden" aria-label="Mobile">
            {links.map(([to, l]) => (
              <Link
                key={to}
                to={to}
                onClick={close}
                className="block rounded-lg px-3 py-3 text-slate-700 hover:bg-slate-100"
              >
                {l}
              </Link>
            ))}
            <div className="flex gap-2 pt-2">
              {session ? (
                <>
                  <Link className="btn-blue flex-1" to={home} onClick={close}>
                    Dashboard
                  </Link>
                  <button className="btn-outline flex-1" onClick={() => void signOutAndGo()}>
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <Link className="btn-outline flex-1" to="/login" onClick={close}>
                    Login
                  </Link>
                  <Link className="btn-primary flex-1" to="/register" onClick={close}>
                    Register
                  </Link>
                </>
              )}
            </div>
          </nav>
        )}
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <footer className="bg-navy text-slate-200">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-2">
          <div>
            <Logo light />
            <p className="mt-2 text-sm">{site.tagline}</p>
            {site.contact.email && <p className="mt-1 text-sm">{site.contact.email}</p>}
            {site.contact.phone && <p className="text-sm">{site.contact.phone}</p>}
          </div>
          <ul className="grid grid-cols-2 gap-2 text-sm">
            {footerLinks.map(([to, l]) => (
              <li key={to}>
                <Link className="hover:text-white" to={to}>
                  {l}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <p className="border-t border-white/10 py-4 text-center text-xs">
          {site.copyright} · {site.developer}
        </p>
      </footer>
    </div>
  )
}
