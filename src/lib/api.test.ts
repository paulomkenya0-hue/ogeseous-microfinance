import { describe, expect, it } from 'vitest'
import { describeError, pageRange, tzs, today } from './api'
import { fileProblem, ownPaths, MAX_BYTES } from './storage'

describe('describeError', () => {
  it('strips the driver noise Supabase wraps around a Postgres message', () => {
    // These messages are written for whoever caused them — a duplicate reference warning is
    // useful, a student staring at "SQLSTATE 23505" is not helped.
    expect(describeError(new Error('Postgres Error: Loan not found'))).toBe('Loan not found')
    expect(describeError(new Error('Application not found or not approved (SQLSTATE P0001)'))).toBe(
      'Application not found or not approved',
    )
  })

  it('never returns an empty string, even for a useless error', () => {
    expect(describeError(new Error(''))).toBe('Something went wrong. Please try again.')
    expect(describeError(null)).toBe('Something went wrong. Please try again.')
    expect(describeError(undefined)).toBe('Something went wrong. Please try again.')
  })

  it('keeps a real message intact', () => {
    const msg = 'Reference "MPESA12345" is already recorded against a repayment.'
    expect(describeError(new Error(msg))).toBe(msg)
  })
})

describe('pageRange', () => {
  it('produces an inclusive range that matches PostgREST .range(from, to)', () => {
    expect(pageRange(0, 25)).toEqual({ from: 0, to: 24 })
    expect(pageRange(1, 25)).toEqual({ from: 25, to: 49 })
    expect(pageRange(3, 50)).toEqual({ from: 150, to: 199 })
  })
})

describe('tzs', () => {
  it('formats a number as Tanzanian shillings', () => {
    expect(tzs(1000000)).toBe('TZS 1,000,000')
    expect(tzs('2500')).toBe('TZS 2,500')
  })

  it('treats null and unparseable values as zero rather than showing NaN', () => {
    // A missing figure reaching a financial report as "TZS NaN" is worse than showing zero.
    expect(tzs(null)).toBe('TZS 0')
    expect(tzs(undefined)).toBe('TZS 0')
    expect(tzs('not a number')).toBe('TZS 0')
  })
})

describe('today', () => {
  it('returns an ISO date, which is what the date inputs expect', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('fileProblem', () => {
  const make = (name: string, type: string, size: number): File =>
    new File([new Uint8Array(size)], name, { type })

  it('accepts the formats the bucket allows', () => {
    expect(fileProblem(make('cert.jpg', 'image/jpeg', 1000))).toBeNull()
    expect(fileProblem(make('cert.png', 'image/png', 1000))).toBeNull()
    expect(fileProblem(make('cert.pdf', 'application/pdf', 1000))).toBeNull()
  })

  it('rejects a file over the 5MB cap that the browser alone used to enforce', () => {
    expect(fileProblem(make('cert.jpg', 'image/jpeg', MAX_BYTES + 1))).toMatch(/5MB or smaller/)
  })

  it('rejects an empty file', () => {
    expect(fileProblem(make('cert.jpg', 'image/jpeg', 0))).toBe('This file is empty')
  })

  it('rejects a type the bucket does not allow, whatever it is named', () => {
    // The extension is derived from the MIME type on upload, but a .php or .exe must never get
    // through on the strength of its name.
    expect(fileProblem(make('passport.php.exe', 'application/x-msdownload', 1000))).toMatch(
      /JPEG, PNG, WebP, HEIC/,
    )
    expect(fileProblem(make('note.txt', 'text/plain', 1000))).toMatch(/JPEG, PNG, WebP, HEIC/)
  })

  it('rejects a missing file', () => {
    expect(fileProblem(null)).toBe('This file is required')
    expect(fileProblem(undefined)).toBe('This file is required')
  })
})

describe('ownPaths', () => {
  const ME = '11111111-1111-1111-1111-111111111111'
  const THEM = '22222222-2222-2222-2222-222222222222'

  it('keeps paths in the caller\'s own folder', () => {
    expect(ownPaths(ME, [`${ME}/certificate-1.jpg`])).toEqual([`${ME}/certificate-1.jpg`])
  })

  it('refuses to delete another student\'s documents', () => {
    // The storage policies already stop this. This is the second lock on a function that deletes.
    expect(ownPaths(ME, [`${THEM}/passport-1.jpg`])).toEqual([])
    expect(ownPaths(ME, [`${ME}/certificate-1.jpg`, `${THEM}/id-1.jpg`])).toEqual([
      `${ME}/certificate-1.jpg`,
    ])
  })

  it('is not fooled by a path that merely contains the id', () => {
    expect(ownPaths(ME, [`${THEM}/${ME}/certificate-1.jpg`])).toEqual([])
    expect(ownPaths(ME, ['certificate-1.jpg'])).toEqual([])
  })

  it('handles the empty case', () => {
    expect(ownPaths(ME, [])).toEqual([])
  })
})