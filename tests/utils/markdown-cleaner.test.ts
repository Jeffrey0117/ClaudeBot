import { describe, it, expect } from 'vitest'
import { cleanMarkdown } from '../../src/utils/markdown-cleaner.js'

describe('cleanMarkdown', () => {
  it('collapses 4+ blank lines down to at most 3 newlines', () => {
    const out = cleanMarkdown('a\n\n\n\n\n\nb')
    expect(out).not.toMatch(/\n{4,}/)
    expect(out).toContain('a')
    expect(out).toContain('b')
  })

  it('strips trailing whitespace on each line', () => {
    expect(cleanMarkdown('foo   \nbar\t')).toBe('foo\nbar')
  })

  it('leaves a short code block intact', () => {
    const out = cleanMarkdown('```js\nconst a = 1\nconst b = 2\n```')
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
    expect(out).not.toContain('more lines)')
  })

  it('truncates a long code block with a remaining-lines marker', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const out = cleanMarkdown('```\n' + lines + '\n```')
    expect(out).toContain('more lines)')
    expect(out).toContain('line0')
    expect(out).not.toContain('line19')
  })
})
