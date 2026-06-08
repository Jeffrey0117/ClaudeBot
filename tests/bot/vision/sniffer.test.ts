import { describe, it, expect } from 'vitest'
import { shouldKeep, truncate, dedupeByMethodUrl, type SniffedCall } from '../../../src/bot/vision/sniffer.js'

describe('shouldKeep', () => {
  it('keeps XHR/Fetch JSON', () => {
    expect(shouldKeep('XHR', 'application/json')).toBe(true)
    expect(shouldKeep('Fetch', 'application/json; charset=utf-8')).toBe(true)
  })
  it('keeps XHR text/plain (APIs often mislabel JSON)', () => {
    expect(shouldKeep('Fetch', 'text/plain')).toBe(true)
  })
  it('drops non-XHR/Fetch resource types', () => {
    expect(shouldKeep('Document', 'application/json')).toBe(false)
    expect(shouldKeep('Image', 'image/png')).toBe(false)
    expect(shouldKeep('Script', 'application/javascript')).toBe(false)
    expect(shouldKeep('Stylesheet', 'text/css')).toBe(false)
  })
  it('drops XHR that is not json/text (e.g. blobs)', () => {
    expect(shouldKeep('XHR', 'application/octet-stream')).toBe(false)
  })
})

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('abc', 800)).toBe('abc')
  })
  it('cuts long strings and marks them', () => {
    const out = truncate('x'.repeat(1000), 800)
    expect(out.length).toBeLessThan(1000)
    expect(out).toContain('…(截斷)')
  })
})

describe('dedupeByMethodUrl', () => {
  it('keeps the last entry per method+url', () => {
    const mk = (over: Partial<SniffedCall>): SniffedCall => ({
      method: 'GET', url: 'u', status: 200, mimeType: 'application/json', bodyBytes: 0, bodyPreview: '', ...over,
    })
    const out = dedupeByMethodUrl([mk({ status: 200 }), mk({ status: 500 }), mk({ method: 'POST' })])
    expect(out).toHaveLength(2)
    expect(out.find((c) => c.method === 'GET')?.status).toBe(500)
  })
})
