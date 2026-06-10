import { timingSafeEqual } from 'node:crypto'

/** Constant-time token comparison (same pattern as ig-web). */
export function isValidToken(provided: string, expected: string): boolean {
  if (expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Extract the token from a request URL's query string. */
export function tokenFromUrl(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
}
