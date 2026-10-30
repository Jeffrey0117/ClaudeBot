import { describe, it, expect } from 'vitest'
import { splitText, tailText } from '../../src/utils/text-splitter.js'

function fenceCount(s: string): number {
  return (s.match(/^[ \t]*```/gm) ?? []).length
}

describe('splitText', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(splitText('hello', 10)).toEqual(['hello'])
  })

  it('returns a single chunk exactly at the limit', () => {
    const s = 'a'.repeat(10)
    expect(splitText(s, 10)).toEqual([s])
  })

  it('hard-cuts an unbroken string and loses no characters', () => {
    const chunks = splitText('a'.repeat(25), 10)
    expect(chunks).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
    expect(chunks.join('')).toBe('a'.repeat(25))
  })

  it('never produces a chunk longer than maxLength', () => {
    const chunks = splitText('word '.repeat(50), 17)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(17)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('prefers a paragraph boundary over a hard cut', () => {
    expect(splitText('aaaa\n\nbbbb', 6)).toEqual(['aaaa', 'bbbb'])
  })

  it('splits on a single newline when there is no paragraph break', () => {
    expect(splitText('aaaa\nbbbb', 6)).toEqual(['aaaa', 'bbbb'])
  })

  it('keeps every chunk fence-balanced when splitting inside a code block', () => {
    const code = '```ts\n' + 'const x = 1\n'.repeat(60) + '```\ntail'
    const chunks = splitText(code, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(fenceCount(chunk) % 2).toBe(0)
    }
  })

  it('reopens the fence with the original language', () => {
    const code = 'intro\n\n```python\n' + 'print(1)\n'.repeat(60) + '```'
    const chunks = splitText(code, 200)
    const continuation = chunks.find((c, i) => i > 0 && c.startsWith('```python'))
    expect(continuation).toBeDefined()
  })

  it('does not touch fence-free splits', () => {
    const text = 'x'.repeat(500)
    const joined = splitText(text, 100).join('')
    expect(joined).toBe(text)
  })

  it('reconstructs full content (minus whitespace trims) for fenced text', () => {
    const code = '```\n' + 'line\n'.repeat(100) + '```'
    const chunks = splitText(code, 150)
    // Strip the synthetic close/reopen fences, then compare line content
    const lines = chunks
      .join('\n')
      .split('\n')
      .filter((l) => l.trim() !== '```' && l.trim() !== '')
    expect(lines.every((l) => l === 'line')).toBe(true)
    expect(lines.length).toBe(100)
  })
})

describe('tailText', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(tailText('short', 20)).toBe('short')
  })

  it('prefixes a truncation marker and keeps the tail when too long', () => {
    const out = tailText('a'.repeat(100), 20)
    expect(out.startsWith('... (truncated)\n')).toBe(true)
    expect(out.endsWith('a')).toBe(true)
  })
})
