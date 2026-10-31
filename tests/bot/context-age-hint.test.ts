import { describe, it, expect } from 'vitest'
import { buildAgeHint } from '../../src/bot/context-digest-store.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('buildAgeHint', () => {
  it('is empty for very recent context (<10 min)', () => {
    expect(buildAgeHint(0)).toBe('')
    expect(buildAgeHint(5 * MIN)).toBe('')
  })

  it('shows minutes for 10–90 min old', () => {
    expect(buildAgeHint(30 * MIN)).toContain('分鐘前')
  })

  it('warns it may be a different task for hours-old context', () => {
    const h = buildAgeHint(5 * HOUR)
    expect(h).toContain('小時前')
    expect(h).toContain('不同任務')
  })

  it('strongly flags day-old context as likely unrelated', () => {
    const h = buildAgeHint(3 * DAY)
    expect(h).toContain('天前')
    expect(h).toContain('忽略')
  })
})
