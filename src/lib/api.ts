import type { PostgrestResponse } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * Every Supabase call resolves rather than throws: a failed query comes back as `{ error }`.
 * The original pages read `.then(({ data }) => ...)` in a dozen places, which silently turned a
 * permission denial into an empty screen — a collections officer saw "no loans in arrears" when
 * in fact their query had been refused. These helpers make it impossible to forget to check.
 */

type Builder<T> = PromiseLike<PostgrestResponse<T>>
type SingleBuilder<T> = PromiseLike<Omit<PostgrestResponse<T>, 'data'> & { data: T }>

/** Unwrap a list/RPC result, throwing on error. */
export async function unwrap<T>(builder: Builder<T>): Promise<T[]> {
  const { data, error } = await builder
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

/** Unwrap a `.single()` result, throwing on error. */
export async function unwrapOne<T>(builder: SingleBuilder<T>): Promise<T> {
  const { data, error } = await builder
  if (error) throw new Error(error.message)
  return data
}

/** Unwrap a `.maybeSingle()` result, throwing only on a real error. */
export async function unwrapMaybe<T>(builder: SingleBuilder<T | null>): Promise<T | null> {
  const { data, error } = await builder
  if (error) throw new Error(error.message)
  return data
}

/** Call an RPC and return its rows. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

/** Call an RPC whose first row is the answer, or null when it returned nothing. */
export async function rpcOne<T>(fn: string, args?: Record<string, unknown>): Promise<T | null> {
  const rows = await rpc<T>(fn, args)
  return rows.length > 0 ? rows[0] : null
}

/**
 * Postgres messages are written to be read by whoever caused them, which is the right person for
 * a duplicate-reference warning but not for a student looking at a loan form. This keeps the
 * message and drops the driver noise around it.
 */
export function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const cleaned = raw
    .replace(/^Postgres Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s*\(SQLSTATE [A-Z0-9]+\)\s*$/i, '')
    .replace(/\s*\(code:\s*[A-Z0-9]+\)\s*$/i, '')
    .trim()
  return cleaned || 'Something went wrong. Please try again.'
}

/** Inclusive row range for a page of results, for use with `.range()`. */
export function pageRange(page: number, size: number): { from: number; to: number } {
  return { from: page * size, to: page * size + size - 1 }
}

/** One TZS amount, formatted the way it appears everywhere in the app. */
export function tzs(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  return `TZS ${Number.isFinite(n) ? n.toLocaleString('en-TZ') : '0'}`
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
