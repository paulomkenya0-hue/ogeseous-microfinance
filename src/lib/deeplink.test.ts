import { describe, expect, it } from 'vitest'
import { restoreDeepLink } from './deeplink'

const SUB = '/ogeseous-microfinance/'
const ROOT = '/'

describe('restoreDeepLink', () => {
  it('does not double the base path — the bug this whole function exists for', () => {
    // 404.html stores the full pathname, which already contains the base. Re-applying the base
    // naively produced /ogeseous-microfinance/ogeseous-microfinance/loan/application.
    expect(restoreDeepLink(`${SUB}loan/application`, SUB)).toBe(`${SUB}loan/application`)
    expect(restoreDeepLink(`${SUB}admin/loans`, SUB)).toBe(`${SUB}admin/loans`)
  })

  it('handles a site served from the domain root', () => {
    expect(restoreDeepLink('/loan/application', ROOT)).toBe('/loan/application')
    expect(restoreDeepLink('/', ROOT)).toBe('/')
  })

  it('preserves the query string, so a password reset link still works', () => {
    expect(restoreDeepLink(`${SUB}reset-password?token=abc123`, SUB)).toBe(
      `${SUB}reset-password?token=abc123`,
    )
  })

  it('refuses a protocol-relative value that would leave this origin', () => {
    // Session storage is not a trust boundary and this value reaches the address bar.
    expect(restoreDeepLink('//evil.example/steal', SUB)).toBeNull()
    expect(restoreDeepLink('//evil.example/steal', ROOT)).toBeNull()
  })

  it('refuses anything that is not an absolute path', () => {
    expect(restoreDeepLink('javascript:alert(1)', SUB)).toBeNull()
    expect(restoreDeepLink('https://evil.example', SUB)).toBeNull()
    expect(restoreDeepLink('loan/application', SUB)).toBeNull()
  })

  it('does nothing when there was nothing stored', () => {
    expect(restoreDeepLink(null, SUB)).toBeNull()
    expect(restoreDeepLink('', SUB)).toBeNull()
  })

  it('never emits a doubled slash at the join', () => {
    expect(restoreDeepLink(`${SUB}admin/loans`, SUB)).not.toContain('//ogeseous')
    expect(restoreDeepLink('/admin/loans', ROOT)).not.toContain('//admin')
  })
})