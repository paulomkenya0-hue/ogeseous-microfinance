import { describe, expect, it } from 'vitest'
import { isEmail, isPhone, toE164, strongPw, PW_HINT, hasErrors } from './validate'

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
  it('accepts the four-to-six digit codes the requirements named', () => {
    expect(strongPw('1234')).toBe(true)
    expect(strongPw('0987')).toBe(true)
    expect(strongPw('1122')).toBe(true)
    expect(strongPw('12345')).toBe(true)
    expect(strongPw('123456')).toBe(true)
  })

  it('rejects fewer than four digits', () => {
    expect(strongPw('123')).toBe(false)
    expect(strongPw('1')).toBe(false)
    expect(strongPw('')).toBe(false)
  })

  it('rejects letters and symbols anywhere', () => {
    // Digits only. No "1234a", no "1234!", no spaces — a student typing a PIN must not be told the
    // PIN is invalid because of one stray character they cannot see.
    expect(strongPw('1234a')).toBe(false)
    expect(strongPw('a1234')).toBe(false)
    expect(strongPw('123!4')).toBe(false)
    expect(strongPw('12 34')).toBe(false)
    expect(strongPw('password1')).toBe(false)
    expect(strongPw('Abcdefghij1')).toBe(false)
  })

  it('accepts a long run of digits, including repeats', () => {
    // Repeated digits were once rejected as obviously weak. The rule is a length and a character
    // class, not a guess about how careful the student was: 1111 is a perfectly valid code under it.
    expect(strongPw('111111111111')).toBe(true)
    expect(strongPw('00000000')).toBe(true)
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