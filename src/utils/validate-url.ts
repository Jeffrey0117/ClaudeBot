/**
 * Shared URL guard for browser/CDP features (SSRF protection).
 * Blocks non-http(s) protocols and internal/private hosts so user-supplied URLs
 * can't be pointed at localhost, link-local, or RFC1918 ranges.
 */

const BLOCKED_URL_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|0\.0\.0\.0|169\.254\.\d+\.\d+)/i

/** Throws if `url` is not http(s) or points at an internal/private host. */
export function validateUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`)
    }
    if (BLOCKED_URL_RE.test(url)) {
      throw new Error('Access to internal/private URLs is not allowed')
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`)
    }
    throw error
  }
}
