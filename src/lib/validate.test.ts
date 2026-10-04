import { describe, expect, it } from 'vitest'
import {
  isEmail,
  isPhone,
  toE164,
  strongPw,
  pinToAuthPassword,
  phoneToAuthEmail,
  PW_HINT,
  hasErrors,
} from './validate'

/**
 * These are the checks that stand between a typed form and the database.
 *
 * The password rule is the one that has moved most: it was "8 characters with a letter and a digit",
 * then 10 characters across three character classes, and is now four or more digits on explicit
 * instruction from the business. The tests below are written against the rule that is actually
 * enforced, and state the examples the requirements named, because those are the cases that decide
 * whether a student can get an account at all.
 */
describe('strongPw', () => {
  it('accepts valid 4-digit PIN', () => {
    expect(strongPw('1234')).toBe(true)
    expect(strongPw('0987')).toBe(true)
    expect(strongPw('1122')).toBe(true)
  })

  it('accepts the boundary PINs, all-zero and all-nine included', () => {
    // The business rule is "exactly four digits" with no excluded values, so these are valid.
    expect(strongPw('0000')).toBe(true)
    expect(strongPw('9999')).toBe(true)
  })

  it('rejects fewer than 4 digits', () => {
    expect(strongPw('123')).toBe(false)
    expect(strongPw('1')).toBe(false)
    expect(strongPw('')).toBe(false)
  })

  it('rejects letters and symbols anywhere', () => {
    // Digits only. No "1234a", no "1234!", no spaces — a student typing a PIN must not be told the
    // PIN is invalid because of one stray character they cannot see.
    expect(strongPw('1234a')).toBe(false)
    expect(strongPw('a1234')).toBe(false)
    expect(strongPw('12a4')).toBe(false)
    expect(strongPw('abcd')).toBe(false)
    expect(strongPw('123!4')).toBe(false)
    expect(strongPw('12 34')).toBe(false)
    expect(strongPw('12 4')).toBe(false)
    expect(strongPw('password1')).toBe(false)
    expect(strongPw('Abcdefghij1')).toBe(false)
  })

  it('rejects more than 4 digits', () => {
    // Exactly 4 digits required
    expect(strongPw('111111111111')).toBe(false)
    expect(strongPw('00000000')).toBe(false)
    expect(strongPw('12345')).toBe(false)
  })

  it('has a hint that matches what it enforces', () => {
    expect(PW_HINT.toLowerCase()).toContain('4')
    expect(PW_HINT.toLowerCase()).toContain('digit')
  })
})

describe('isEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isEmail('student@rucu.ac.tz')).toBe(true)
    expect(isEmail('  spaced@example.com  ')).toBe(true)
  })

  it('rejects what Supabase Auth would reject anyway', () => {
    expect(isEmail('no-at-sign')).toBe(false)
    expect(isEmail('two@@example.com')).toBe(false)
    expect(isEmail('trailing@dot.')).toBe(false)
    expect(isEmail('spaces in@example.com')).toBe(false)
    expect(isEmail('')).toBe(false)
  })
})

describe('isPhone', () => {
  it('accepts the formats people actually type', () => {
    expect(isPhone('+255754123456')).toBe(true)
    expect(isPhone('0754123456')).toBe(true)
    expect(isPhone('0754 123 456')).toBe(true)
    expect(isPhone('0754-123-456')).toBe(true)
    expect(isPhone('+255 754 123 456')).toBe(true)
  })

  it('counts digits rather than characters', () => {
    // The old rule counted characters, so "0754 123 456" — eleven characters, nine digits, the way
    // it is written on every receipt in the country — failed on length while passing on content.
    expect(isPhone('0754 123 456')).toBe(true)
    expect(isPhone('0754-123-456')).toBe(true)
  })

  it('does not insist on ten digits', () => {
    // A nine-digit national number and a longer international one are both real numbers.
    expect(isPhone('754123456')).toBe(true)
    expect(isPhone('+255754123456')).toBe(true)
  })

  it('rejects nonsense and short numbers', () => {
    expect(isPhone('12345')).toBe(false)
    expect(isPhone('call me')).toBe(false)
    expect(isPhone('')).toBe(false)
    expect(isPhone('+25575412345678901')).toBe(false)
  })
})

describe('toE164', () => {
  /**
   * This exists because the signup form registers against a phone number, and Supabase only accepts
   * E.164 for a phone identity. Anything not normalised here is a signup failure that the student
   * cannot diagnose, because the field they filled in looks perfectly correct.
   */

  it('converts the national format by swapping the trunk zero for the country code', () => {
    expect(toE164('0754123456')).toBe('+255754123456')
    expect(toE164('0754 123 456')).toBe('+255754123456')
    expect(toE164('0754-123-456')).toBe('+255754123456')
  })

  it('reads a bare national number as Tanzanian', () => {
    expect(toE164('754123456')).toBe('+255754123456')
  })

  it('passes an already international number through unchanged', () => {
    expect(toE164('+255754123456')).toBe('+255754123456')
    expect(toE164('+255 754 123 456')).toBe('+255754123456')
    expect(toE164('255754123456')).toBe('+255754123456')
  })

  it('rejects what is not a usable number', () => {
    expect(toE164('')).toBeNull()
    expect(toE164('12345')).toBeNull()
    expect(toE164('call me')).toBeNull()
  })

  it('agrees with isPhone about what counts as a number', () => {
    // If one accepts a value the other rejects, the student gets past the form and fails at the API
    // with an error they have no way to interpret.
    for (const v of [
      '',
      '12345',
      'call me',
      '0754123456',
      '+255754123456',
      '0754 123 456',
      '+123456789', // nine digits, foreign country code: both accept, the server judges it
      '2547541234567', // fourteen digits
    ]) {
      expect(isPhone(v)).toBe(toE164(v) !== null)
    }
  })
})

describe('hasErrors', () => {
  it('ignores a field whose message has been cleared', () => {
    // A leftover empty string must not block the form forever with no visible reason.
    expect(hasErrors({ email: '' })).toBe(false)
    expect(hasErrors({ email: '   ' })).toBe(false)
    expect(hasErrors({})).toBe(false)
  })

  it('reports a field with a real message', () => {
    expect(hasErrors({ email: 'bad' })).toBe(true)
    expect(hasErrors({ email: '', pw: 'too short' })).toBe(true)
  })
})

describe('pinToAuthPassword', () => {
  /**
   * The stretched PIN is what actually reaches Supabase Auth, whose own minimum password length
   * (six by default) rejected the bare four digits before any app code ran — the failure behind
   * "your PIN does not meet the minimum length requirement" on a valid PIN.
   */
  it('stretches every PIN past the auth server default minimum length', () => {
    for (const pin of ['1234', '0000', '9999']) {
      expect(pinToAuthPassword(pin).length).toBeGreaterThanOrEqual(6)
    }
  })

  it('keeps the PIN as the prefix and is deterministic', () => {
    // Registration and sign-in must produce byte-identical values, or nobody could ever log in.
    expect(pinToAuthPassword('1234').startsWith('1234')).toBe(true)
    expect(pinToAuthPassword('1234')).toBe(pinToAuthPassword('1234'))
  })

  it('maps distinct PINs to distinct passwords', () => {
    expect(pinToAuthPassword('1234')).not.toBe(pinToAuthPassword('1235'))
    expect(pinToAuthPassword('0000')).not.toBe(pinToAuthPassword('0001'))
  })

  it('carries several character classes, so stricter server presets still accept it', () => {
    const pw = pinToAuthPassword('1234')
    expect(/[a-z]/.test(pw)).toBe(true)
    expect(/[A-Z]/.test(pw)).toBe(true)
    expect(/\d/.test(pw)).toBe(true)
    expect(/[^A-Za-z0-9]/.test(pw)).toBe(true)
  })
})

describe('phoneToAuthEmail', () => {
  it('matches the address existing accounts were registered with', () => {
    // Regression lock: this exact string is auth.users.email for every account already created.
    expect(phoneToAuthEmail('+255754123456')).toBe('phone_plus255754123456@ogeseous.local')
  })

  it('is deterministic, so registration and sign-in can never drift apart', () => {
    expect(phoneToAuthEmail('+255754123456')).toBe(phoneToAuthEmail('+255754123456'))
  })
})