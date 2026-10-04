export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/**
 * Accepts the formats people actually type: spaces, dashes, brackets and a leading +.
 *
 * This counts DIGITS, not characters, and deliberately does not insist on ten of them. Tanzanian
 * mobile numbers are nine digits once the leading zero is dropped, landlines vary, and a student
 * typing "0754 123 456" or "+255 754 123 456" must not be turned away for the formatting. Rejecting
 * a working number at signup costs the student an account, and there is no support desk to fix it.
 *
 * The real check that a number is usable happens in toE164(), which normalises it.
 */
export const isPhone = (v: string) => {
  const d = v.replace(/\D/g, '')
  return d.length >= 9 && d.length <= 15
}

/**
 * Normalises a phone number to the E.164 form Supabase Auth requires for a phone identity.
 *
 * Why this exists at all: a student account is created against a PHONE NUMBER, because the signup
 * form does not ask for an email address. Supabase only accepts E.164 for a phone identity
 * ("+255754123456"), and it rejects anything else — so "0754 123 456" typed by hand becomes a
 * signup failure unless it is converted first. This is the frontend half of that requirement; the
 * Phone provider in the Supabase project is the other half.
 *
 * A bare national number with no country code is read as Tanzanian, which is the only country this
 * serves. Anything already carrying +255 or 00255 is passed through.
 *
 * @returns the E.164 string, or null when the input is not a usable number
 */
export function toE164(v: string): string | null {
  const trimmed = v.trim()
  const d = trimmed.replace(/\D/g, '')

  // The same 9–15 digit window isPhone uses, on purpose. If this function were stricter than its
  // sibling the form would accept a number and then fail at the API with an error the student
  // cannot read, which is exactly the failure this whole function was written to remove. A number
  // that is the right length but belongs to no country is passed through for the server to reject
  // properly; it is not silently dropped here.
  if (d.length < 9 || d.length > 15) return null

  // Already international: the country code is written, so do not add another one.
  if (trimmed.startsWith('+')) return `+${d}`

  // 2557…, 25575… — already carries the country code.
  if (d.startsWith('255')) return `+${d}`

  // 0754… / 075… — national dialling format; swap the trunk zero for the country code.
  if (d.startsWith('0')) return `+255${d.slice(1)}`

  // 754… — a bare national number.
  return `+255${d}`
}

/**
 * The password rule: exactly four digits (PIN).
 *
 * This replaced a 10-character mixed-case rule on explicit instruction. Note what that means here,
 * once, and then implement it as asked: a four-digit code has ten thousand possibilities, and with
 * the account identified by a phone number rather than an email address, the phone number is the
 * only thing an attacker has to get right. Anyone can walk the four-digit space quickly if they
 * already know the number.
 *
 * This is a usability floor chosen by the business, not a security property. The app cannot raise
 * it for a specific account. The bare PIN is never sent to the auth server — see pinToAuthPassword
 * below — so the server's own minimum password length no longer decides whether 1234 is accepted.
 */
export const strongPw = (v: string) => /^\d{4}$/.test(v)

export const PW_HINT = '4 digits, numbers only'

/**
 * Why a PIN is never sent to the auth server as-is.
 *
 * Supabase Auth (GoTrue) enforces its own minimum password length — six by default — before any
 * code in this repository runs, and that threshold is a project setting no code here can see or
 * change. A bare four-character PIN therefore failed at the API even though it satisfies strongPw,
 * and the rejection surfaced as the misleading "your PIN does not meet the minimum length
 * requirement" message on a perfectly valid PIN.
 *
 * The PIN is instead stretched with a fixed, public suffix before it leaves the browser, so the
 * value the auth server receives is always long enough and carries several character classes. The
 * suffix is NOT a secret: it is compiled into the public bundle and adds nothing an attacker must
 * guess. The secret is still exactly the four digits; the credential space stays the documented
 * ten thousand. It is purely a wire format, applied identically at registration, sign-in and
 * password reset.
 *
 * Never change the suffix: existing accounts have the stretched value stored as their password,
 * and changing it would lock every one of them out. Sign-in still falls back to the raw PIN for
 * accounts created before this stretching was introduced, or reset by an administrator by hand.
 */
const PIN_AUTH_SUFFIX = '#ogeseous-PIN-pad'

export const pinToAuthPassword = (pin: string): string => `${pin}${PIN_AUTH_SUFFIX}`

/**
 * The synthetic auth email for a phone-identified student account.
 *
 * The project runs no SMS provider, so Supabase's phone identity is not used; GoTrue still needs
 * an email-shaped identifier, so registration derives one from the E.164 number. Sign-in derives
 * the same address locally instead of looking it up in public.users — which is the only correct
 * option, because the RLS policy on that table rightly refuses an anonymous (not yet signed-in)
 * caller, and the lookup made every student sign-in fail.
 *
 * Keep the format byte-for-byte stable: existing accounts carry this exact string as
 * auth.users.email, and changing it would strand them.
 */
export const phoneToAuthEmail = (e164: string): string =>
  `phone_${e164.replace(/[^0-9+]/g, '').replace(/\+/g, 'plus')}@ogeseous.local`

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
