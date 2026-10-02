import { useCallback, useEffect, useRef, useState } from 'react'
import { describeError, pageRange } from './api'

/**
 * Anything that settles like a Supabase builder: a resolved object, not a promise that throws.
 *
 * `data` is deliberately `unknown`. The Supabase client infers the shape of `select(...)` and would
 * otherwise demand a structural match against the caller's row type — which breaks the moment a
 * query embeds a count or a foreign table, and gives no real safety in exchange. The cast to T[]
 * below is the same one the rest of the codebase makes at the point of use.
 */
type Query = PromiseLike<{
  data: unknown
  error: { message: string } | null
  count?: number | null
}>

export type AdminList<T> = {
  rows: T[]
  /** Total rows the server reports, or the rows we got when it does not report one (RPCs). */
  count: number
  /** True when the result set came back complete, so a pager is worth showing. */
  pageable: boolean
  page: number
  setPage: (p: number) => void
  loading: boolean
  error: string
  reload: () => void
}

/**
 * Every admin page had its own `load()` that read `.then(({ data }) => ...)` and dropped `error`
 * on the floor. A collections officer whose query was refused by RLS therefore saw an empty table
 * and a green tick, with no way to tell "nothing in arrears" from "you cannot see arrears".
 *
 * This is the one implementation: the error is surfaced, the result set is bounded, and there is
 * a retry. `build` receives a row range and should apply `.range(from, to)` and
 * `{ count: 'exact' }`.
 */
export function useAdminList<T>(build: (from: number, to: number) => Query, pageSize = 25): AdminList<T> {
  // Kept in a ref so callers can pass an inline closure without retriggering on every render.
  const buildRef = useRef(build)
  buildRef.current = build

  const [rows, setRows] = useState<T[]>([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let active = true
    setLoading(true)
    const { from, to } = pageRange(page, pageSize)

    buildRef.current(from, to).then(
      (res) => {
        if (!active) return
        setLoading(false)
        if (res.error) {
          setError(describeError(res.error))
          setRows([])
          setCount(0)
          return
        }
        const data = (Array.isArray(res.data) ? res.data : []) as T[]
        setError('')
        setRows(data)
        setCount(res.count ?? data.length)
      },
      (e) => {
        if (!active) return
        setLoading(false)
        setError(describeError(e))
      },
    )

    return () => {
      active = false
    }
  }, [page, pageSize, tick])

  return {
    rows,
    count,
    pageable: count > pageSize,
    page,
    setPage,
    loading,
    error,
    reload,
  }
}