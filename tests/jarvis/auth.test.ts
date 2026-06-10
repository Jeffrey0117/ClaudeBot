import { describe, it, expect } from 'vitest'
import { isValidToken, tokenFromUrl } from '../../src/jarvis/auth.js'

describe('isValidToken', () => {
  it('accepts a matching token', () => {
    expect(isValidToken('secret123', 'secret123')).toBe(true)
  })

  it('rejects a wrong token', () => {
    expect(isValidToken('secret124', 'secret123')).toBe(false)
  })

  it('rejects a token of different length', () => {
    expect(isValidToken('secret', 'secret123')).toBe(false)
  })

  it('rejects empty provided token', () => {
    expect(isValidToken('', 'secret123')).toBe(false)
  })

  it('rejects everything when expected token is empty (server misconfig)', () => {
    expect(isValidToken('', '')).toBe(false)
    expect(isValidToken('anything', '')).toBe(false)
  })
})

describe('tokenFromUrl', () => {
  it('extracts token from query string', () => {
    expect(tokenFromUrl('/?token=abc123')).toBe('abc123')
    expect(tokenFromUrl('/ws?token=xyz')).toBe('xyz')
  })

  it('returns empty string when token is missing', () => {
    expect(tokenFromUrl('/')).toBe('')
    expect(tokenFromUrl(undefined)).toBe('')
  })

  it('decodes URL-encoded tokens', () => {
    expect(tokenFromUrl('/ws?token=a%2Bb')).toBe('a+b')
  })
})
