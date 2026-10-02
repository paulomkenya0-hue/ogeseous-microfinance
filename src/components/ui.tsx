import type { ReactNode } from 'react'
import { tzs } from '../lib/api'

export const Card = ({
  title,
  hint,
  actions,
  children,
}: {
  title?: string
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) => (
  <section className="card">
    {title && (
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-navy">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {actions}
      </header>
    )}
    {children}
  </section>
)

/**
 * Errors are shown, not swallowed. A blank table is indistinguishable from an empty one, and in
 * this system that difference is a collections officer believing the portfolio is clear.
 */
export const ErrorNote = ({ error, onRetry }: { error: string; onRetry?: () => void }) =>
  error ? (
    <div
      role="alert"
      className="mb-3 flex items-start justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-800"
    >
      <span>{error}</span>
      {onRetry && (
        <button className="btn-outline shrink-0 px-2 py-1 text-xs" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  ) : null

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-slate-600">{children}</p>
)

export const TONE = {
  slate: 'bg-slate-100 text-slate-700',
  amber: 'bg-amber-100 text-amber-800',
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-800',
  navy: 'bg-navy/10 text-navy',
} as const

export type Tone = keyof typeof TONE

export const Badge = ({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${TONE[tone]}`}>
    {children}
  </span>
)

export const STATUS_TONE: Record<string, Tone> = {
  NOT_STARTED: 'slate',
  PENDING: 'amber',
  SUBMITTED: 'amber',
  UNDER_REVIEW: 'blue',
  VERIFIED: 'green',
  APPROVED: 'green',
  ACTIVE: 'green',
  REJECTED: 'red',
  DEFAULTED: 'red',
  SUSPENDED: 'red',
  CLOSED: 'slate',
  DISBURSED: 'navy',
}

/** Money always goes through this so a reversed or negative figure is impossible to misread. */
export const Money = ({ value }: { value: number | string | null | undefined }) => (
  <span className="tabular-nums">{tzs(value)}</span>
)

export const Table = ({
  head,
  children,
}: {
  head: string[]
  children: ReactNode
}) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-slate-500">
          {head.map((h) => (
            <th key={h} className="py-2 pr-3 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
)

export const Pager = ({
  page,
  count,
  pageSize,
  onPage,
}: {
  page: number
  count: number
  pageSize: number
  onPage: (p: number) => void
}) => {
  const last = Math.max(0, Math.ceil(count / pageSize) - 1)
  if (last === 0) return null
  const from = page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, count)
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
      <span>
        Showing {from}–{to} of {count}
      </span>
      <div className="flex gap-2">
        <button className="btn-outline px-2 py-1" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn-outline px-2 py-1" disabled={page === last} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  )
}

/**
 * Confirmation for an irreversible or money-moving action.
 *
 * The reason is required, not optional. review_verification and reverse_repayment both refuse an
 * empty one, because a reversal with no stated cause is indistinguishable from a quiet removal of
 * an inconvenient entry.
 */
export function askReason(question: string, minLength = 3): string | null {
  const answer = window.prompt(question)
  if (answer === null) return null // cancelled
  const trimmed = answer.trim()
  if (trimmed.length < minLength) {
    window.alert(`Please give at least ${minLength} characters. This is kept in the audit log.`)
    return null
  }
  return trimmed
}

/** Confirmation for an action that moves money or destroys a record. */
export function confirmAction(question: string): boolean {
  return window.confirm(question)
}

export const date = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleDateString() : '—'

export const dateTime = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleString() : '—'