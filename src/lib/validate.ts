export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/** Accepts the formats people actually type: spaces, dashes and a leading +. */
export const isPhone = (v: string) => /^\+?[0-9\s-]{9,15}$/.test(v.trim())

/**
 * 8 characters with a letter and a digit was the original rule. That accepts "password1" and
 * "aaaaaaaaa1", which is why it is being replaced rather than extended: this is the single
 * credential protecting a student's identity documents and a real loan balance.
 *
 * Note this is a usability floor, not the security boundary — Supabase Auth owns the stored
 * credential. Its minimum password policy should be set to match (see SECURITY.md).
 */
export const strongPw = (v: string) =>
  v.length >= 10 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v) && !/^(.)\1+$/.test(v)

export const PW_HINT = 'At least 10 characters, with upper case, lower case and a number'

/** Shared shape for field-level validation errors. */
export type Errors = Record<string, string>

/**
 * True only if some field actually has a message.
 *
 * This deliberately ignores empty strings rather than counting keys. Every caller builds a fresh
 * object per submission and assigns only real messages, so both versions work today — but a
 * `next.email = ''` left behind from a cleared error would silently block the form forever with a
 * key-count check and no visible reason why. Callers that clear a field should pass an empty
 * object instead.
 */
export const hasErrors = (e: Errors) => Object.values(e).some((m) => m.trim() !== '')
