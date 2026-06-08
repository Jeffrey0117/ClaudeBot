import { describe, it, expect } from 'vitest'
import { parseUserscriptMeta, matchesUrl } from '../../../src/bot/vision/userscript-meta.js'

const CODE = `// ==UserScript==
// @name        IG DL
// @match       *://*.instagram.com/*
// @include     https://instagram.com/*
// @grant       GM_download
// @grant       GM_xmlhttpRequest
// ==/UserScript==
console.log('body')`

describe('parseUserscriptMeta', () => {
  it('extracts name, match/include, and grants', () => {
    const m = parseUserscriptMeta(CODE)
    expect(m.name).toBe('IG DL')
    expect(m.match).toContain('*://*.instagram.com/*')
    expect(m.match).toContain('https://instagram.com/*')
    expect(m.grants).toEqual(['GM_download', 'GM_xmlhttpRequest'])
  })
  it('returns empties when there is no metadata block', () => {
    expect(parseUserscriptMeta('console.log(1)')).toEqual({ name: undefined, match: [], grants: [], requires: [], resources: [] })
  })
})

describe('parseUserscriptMeta @require/@resource', () => {
  const code = `// ==UserScript==
// @name X
// @require https://code.jquery.com/jquery-3.7.1.min.js
// @require https://cdn.jsdelivr.net/npm/mediabunny/dist/x.cjs
// @resource INTERNAL_CSS https://example.com/style.css
// @resource LOCALE https://example.com/l.json
// @grant GM_xmlhttpRequest
// ==/UserScript==
body`
  it('extracts requires and resources', () => {
    const m = parseUserscriptMeta(code)
    expect(m.requires).toEqual([
      'https://code.jquery.com/jquery-3.7.1.min.js',
      'https://cdn.jsdelivr.net/npm/mediabunny/dist/x.cjs',
    ])
    expect(m.resources).toEqual([
      { name: 'INTERNAL_CSS', url: 'https://example.com/style.css' },
      { name: 'LOCALE', url: 'https://example.com/l.json' },
    ])
  })
  it('empties when absent', () => {
    const m = parseUserscriptMeta('// ==UserScript==\n// @name X\n// ==/UserScript==')
    expect(m.requires).toEqual([])
    expect(m.resources).toEqual([])
  })
})

describe('matchesUrl', () => {
  it('matches Tampermonkey glob patterns', () => {
    expect(matchesUrl('https://www.instagram.com/p/abc', ['*://*.instagram.com/*'])).toBe(true)
    expect(matchesUrl('https://example.com/', ['*://*.instagram.com/*'])).toBe(false)
  })
  it('<all_urls> matches any http(s) url', () => {
    expect(matchesUrl('https://x.com', ['<all_urls>'])).toBe(true)
  })
  it('no patterns means no match', () => {
    expect(matchesUrl('https://x.com', [])).toBe(false)
  })
})
