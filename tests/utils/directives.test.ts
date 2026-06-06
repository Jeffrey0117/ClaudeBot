import { describe, it, expect } from 'vitest'
import { parseDirectives, stripDirectives } from '../../src/utils/directives.js'

const FENCE = '```'

describe('parseDirectives', () => {
  it('parses @file with its path', () => {
    const d = parseDirectives('@file(report.pdf)')
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ type: 'file', path: 'report.pdf' })
  })

  it('accepts fullwidth Chinese brackets', () => {
    const d = parseDirectives('@file（a.txt）')
    expect(d[0]).toMatchObject({ type: 'file', path: 'a.txt' })
  })

  it('accepts backtick-wrapped directives', () => {
    const d = parseDirectives('`@file(a.txt)`')
    expect(d[0]).toMatchObject({ type: 'file', path: 'a.txt' })
  })

  it('SECURITY: ignores directives inside a code block', () => {
    const text = `${FENCE}\n@file(secret.env)\n${FENCE}`
    expect(parseDirectives(text)).toEqual([])
  })

  it('parses @confirm into question + options', () => {
    const d = parseDirectives('@confirm(繼續嗎|是|否)')
    expect(d[0]).toMatchObject({ type: 'confirm', question: '繼續嗎', options: ['是', '否'] })
  })

  it('ignores @confirm with fewer than 2 parts', () => {
    expect(parseDirectives('@confirm(只有問題)')).toEqual([])
  })

  it('parses @notify message', () => {
    expect(parseDirectives('@notify(嗨)')[0]).toMatchObject({ type: 'notify', message: '嗨' })
  })

  it('parses @unpin(N) into a numeric index', () => {
    expect(parseDirectives('@unpin(3)')[0]).toMatchObject({ type: 'unpin', index: 3 })
  })

  it('parses @pin_update(N, text)', () => {
    expect(parseDirectives('@pin_update(2, 新文字)')[0]).toMatchObject({
      type: 'pin_update', index: 2, text: '新文字',
    })
  })

  it('returns [] for plain prose with no directives', () => {
    expect(parseDirectives('just a normal sentence')).toEqual([])
  })
})

describe('stripDirectives', () => {
  it('removes a directive line from displayed text', () => {
    const out = stripDirectives('hello\n@notify(hi)\nworld')
    expect(out).not.toContain('@notify')
    expect(out).toContain('hello')
    expect(out).toContain('world')
  })

  it('leaves normal prose untouched (aside from trim)', () => {
    expect(stripDirectives('  just text  ')).toBe('just text')
  })

  it('collapses the blank gap left behind to at most two newlines', () => {
    expect(stripDirectives('a\n@notify(x)\n\n\nb')).not.toMatch(/\n{3,}/)
  })
})
