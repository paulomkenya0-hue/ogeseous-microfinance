/**
 * Rebuilding the URL after GitHub Pages bounces a deep link off public/404.html.
 *
 * Extracted from main.tsx, where it cannot be reached by the tests, and tested there instead. This
 * is the one piece of routing logic that has to be right about both a base path and an
 * untrusted value, and both bugs that were fixed during the audit were found by reasoning about it
 * rather than by seeing it run — which is exactly the sign that it needs tests.
 */

/**
 * @param bounced the path 404.html stashed in sessionStorage (a full pathname, including base)
 * @param base    Vite's `base`, i.e. `import.meta.env.BASE_URL` — '/ogeseous-microfinance/' or '/'
 * @returns the URL to restore, or null if the stored value cannot be trusted
 */
export function restoreDeepLink(bounced: string | null, base: string): string | null {
  if (!bounced) return null

  // Session storage is not a trust boundary, and this ends up on the address bar. A protocol-
  // relative value would send the visitor to another origin.
  if (!bounced.startsWith('/') || bounced.startsWith('//')) return null

  // 404.html records the whole pathname, which already carries the base. Strip it before putting
  // it back, or the path doubles: /ogeseous-microfinance/ogeseous-microfinance/loan/application.
  const withoutBase = bounced.startsWith(base) ? bounced.slice(base.length - 1) : bounced

  // Strip any remaining leading slashes so the join never produces '//'.
  return base + withoutBase.replace(/^\/+/, '')
}

/** The key shared by public/404.html and main.tsx. Kept in one place so the two cannot drift. */
export const REDIRECT_KEY = 'ogeseous:redirect'