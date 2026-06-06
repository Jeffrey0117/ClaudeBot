import { describe, it, expect } from 'vitest'
import { splitText, tailText } from '../../src/utils/text-splitter.js'

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
