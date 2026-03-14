/**
 * SSRF guard — validates URLs to prevent Server-Side Request Forgery.
 * Shared by browse-vision.ts and browser-session.ts.
 */

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
]

export function isSsrfBlocked(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return true
    return BLOCKED_HOSTS.some((re) => re.test(parsed.hostname))
  } catch {
    return true
  }
}
