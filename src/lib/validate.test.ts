import { describe, expect, it } from 'vitest'
import { isEmail, isPhone, strongPw, PW_HINT, hasErrors } from './validate'

/**
 * These are the checks that stand between a typed form and the database. The password rule in
 * particular replaced "8 characters with a letter and a digit", which accepted 'password1' and
 * 'aaaaaaaaa1'.
 */
describe('strongPw', () => {
  it('rejects the passwords the old 8-character rule accepted', () => {
    expect(strongPw('password1')).toBe(false)
    expect(strongPw('abcdefgh1')).toBe(false)
    expect(strongPw('PASSWORD1')).toBe(false)
  })

  it('rejects a single repeated character', () => {
    expect(strongPw('aaaaaaaaaaaa')).toBe(false)
    expect(strongPw('111111111111')).toBe(false)
  })

  it('rejects anything too short', () => {
    expect(strongPw('Ab1cdefg')).toBe(false) // 8 characters
    expect(strongPw('Ab1cdefgh')).toBe(false) // 9 characters
  })

  it('rejects a missing character class', () => {
    expect(strongPw('abcdefghij1')).toBe(false) // no upper case
    expect(strongPw('ABCDEFGHIJ1')).toBe(false) // no lower case
    expect(strongPw('Abcdefghij')).toBe(false) // no digit
    expect(strongPw('Abcdefghij1')).toBe(true) // all three classes, 11 characters
  })

  it('accepts a long mixed password', () => {
    expect(strongPw('Str0ngEnough9')).toBe(true)
    expect(strongPw('correct-horse-Battery9')).toBe(true)
  })

  it('has a hint that matches what it enforces', () => {
    expect(PW_HINT.toLowerCase()).toContain('10')
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
  })

  it('rejects nonsense and short numbers', () => {
    expect(isPhone('12345')).toBe(false)
    expect(isPhone('call me')).toBe(false)
    expect(isPhone('+25575412345678901')).toBe(false)
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