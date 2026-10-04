import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import { restoreDeepLink, REDIRECT_KEY } from './lib/deeplink'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing its #root element')

// Restore a deep link that GitHub Pages bounced off the SPA: Pages has no rewrite rules, so it
// serves public/404.html for any route path. Without this a student who refreshed /loan/application,
// or followed a password reset link, would land on the homepage with no way back.
// Done before React mounts, because BrowserRouter reads the URL once.
const restored = restoreDeepLink(sessionStorage.getItem(REDIRECT_KEY), import.meta.env.BASE_URL)
sessionStorage.removeItem(REDIRECT_KEY)
if (restored) history.replaceState(null, '', restored)

createRoot(root).render(
  <StrictMode>
    {/* Outside the router on purpose: this has to catch a failure in the router itself. */}
    <ErrorBoundary title="OGESEOUS Microfinance could not start">
      {/*
        basename is not optional here. The app is served from /ogeseous-microfinance/ on GitHub
        Pages, and without it React Router treats that prefix as part of the route — so every URL
        fell through to the "Page not found" route. It comes from the same `base` Vite uses to
        build asset URLs, so the two cannot drift.
      */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)