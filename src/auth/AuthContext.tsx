import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured } from '../lib/supabase'
import { describeError } from '../lib/api'
import type { Role } from '../config/site'

/**
 * role is deliberately a three-state value:
 *
 *   undefined  the lookup has not settled yet  -> show a loading state
 *   null       settled, and there is no usable role -> deny, do not pretend to be loading
 *   a Role     settled
 *
 * The original context collapsed "still asking" and "asked, and the answer was no" into a single
 * null, so ProtectedRoute sent anyone whose role had not arrived yet to /login. On a slow
 * connection that logged people out mid-session.
 */
type AuthValue = {
  session: Session | null
  role: Role | null | undefined
  loading: boolean
  error: string
  recovery: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
  clearRecovery: () => void
}

const AuthContext = createContext<AuthValue>({
  session: null,
  role: undefined,
  loading: true,
  error: '',
  recovery: false,
  refresh: async () => {},
  signOut: async () => {},
  clearRecovery: () => {},
})

export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<Role | null | undefined>(undefined)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState(false)

  /**
   * Role and account status come from public.users, not from the JWT, so that suspending someone
   * takes effect on their next request rather than when their token happens to expire.
   */
  const loadRole = useCallback(async (s: Session | null) => {
    if (!s) {
      setRole(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data, error: err } = await supabase
        .from('users')
        .select('role,status')
        .eq('id', s.user.id)
        .maybeSingle()
      if (err) throw new Error(err.message)
      setRole(data && data.status === 'ACTIVE' ? (data.role as Role) : null)
    } catch (e) {
      // Leave the role undefined. That is what makes ProtectedRoute offer a retry instead of
      // bouncing a signed-in user to the login page because one query failed.
      setRole(undefined)
      setError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!configured) {
      setLoading(false)
      return
    }

    let active = true
    supabase.auth.getSession().then(({ data, error: err }) => {
      if (!active) return
      if (err) {
        setError(describeError(err))
        setLoading(false)
        return
      }
      setSession(data.session)
      void loadRole(data.session)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecovery(true)
        return
      }
      setSession(s)
      // Deferred deliberately: calling another Supabase client method directly inside this
      // callback can deadlock against the auth client's own lock.
      setTimeout(() => void loadRole(s), 0)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [configured, loadRole])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setRole(null)
    setRecovery(false)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      session,
      role,
      loading,
      error,
      recovery,
      refresh: () => loadRole(session),
      signOut,
      clearRecovery: () => setRecovery(false),
    }),
    [session, role, loading, error, recovery, loadRole, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
