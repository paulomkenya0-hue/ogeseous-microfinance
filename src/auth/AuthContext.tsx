import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured } from '../lib/supabase'
import type { Role } from '../config/site'
type Ctx = { session: Session | null; role: Role | null; loading: boolean; signOut: () => Promise<void> }
const C = createContext<Ctx>({ session: null, role: null, loading: true, signOut: async () => {} })
export const useAuth = () => useContext(C)
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<Role | null>(null)
  const [loading, setLoading] = useState(configured)
  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (!s) { setRole(null); setLoading(false) } })
    return () => sub.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (!session) return
    setLoading(true)
    supabase.from('users').select('role,status').eq('id', session.user.id).single()
      .then(({ data }) => { setRole(data && data.status === 'ACTIVE' ? (data.role as Role) : null); setLoading(false) })
  }, [session])
  return <C.Provider value={{ session, role, loading, signOut: async () => { await supabase.auth.signOut() } }}>{children}</C.Provider>
}
