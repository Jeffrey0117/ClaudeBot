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

/**
 * Resolve a potentially relative URL against a base page URL.
 * Returns the resolved absolute URL, or null if it can't be resolved.
 */
export function resolveUrl(maybeRelative: string, pageUrl: string): string | null {
  // Already absolute
  try {
    const parsed = new URL(maybeRelative)
    if (['http:', 'https:'].includes(parsed.protocol)) return maybeRelative
  } catch { /* not absolute — try resolving */ }

  // Auto-prepend https:// for bare domains (e.g. "codelove.tw/path")
  if (/^[\w.-]+\.\w{2,}/.test(maybeRelative)) {
    try {
      const withProto = `https://${maybeRelative}`
      new URL(withProto)
      return withProto
    } catch { /* not a bare domain */ }
  }

  // Resolve as relative against current page
  try {
    return new URL(maybeRelative, pageUrl).href
  } catch {
    return null
  }
}
