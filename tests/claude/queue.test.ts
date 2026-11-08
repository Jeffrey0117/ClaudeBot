import { describe, it, expect } from 'vitest'
import { mergeQueueItems, canMergeInto } from '../../src/claude/queue.js'
import type { QueueItem } from '../../src/types/index.js'

function make(over: Partial<QueueItem>): QueueItem {
  return {
    chatId: 1,
    prompt: 'p',
    project: { name: 'x', path: '/x' },
    ai: { backend: 'claude', model: 'sonnet' },
    sessionId: null,
    imagePaths: [],
    ...over,
  }
}

describe('mergeQueueItems', () => {
  it('returns the first item unchanged when there are no follow-ups', () => {
    const first = make({ prompt: 'only' })
    expect(mergeQueueItems(first, [])).toBe(first)
  })

  it('numbers and merges multiple prompts', () => {
    const merged = mergeQueueItems(make({ prompt: 'A' }), [make({ prompt: 'B' })])
    expect(merged.prompt).toContain('1. A')
    expect(merged.prompt).toContain('2. B')
    expect(merged.prompt).toContain('多個任務')
  })

  it('concatenates images across merged items', () => {
    const merged = mergeQueueItems(
      make({ imagePaths: ['a.png'] }),
      [make({ imagePaths: ['b.png', 'c.png'] })],
    )
    expect(merged.imagePaths).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('takes the highest maxTurns of all merged items', () => {
    const merged = mergeQueueItems(make({ maxTurns: 5 }), [make({ maxTurns: 12 })])
    expect(merged.maxTurns).toBe(12)
  })

  it('leaves maxTurns undefined when none set', () => {
    const merged = mergeQueueItems(make({ prompt: 'A' }), [make({ prompt: 'B' })])
    expect(merged.maxTurns).toBeUndefined()
  })
})

describe('canMergeInto', () => {
  it('merges plain same-chat Telegram items', () => {
    expect(canMergeInto(make({}), make({}))).toBe(true)
  })

  it('refuses a different chat', () => {
    expect(canMergeInto(make({ chatId: 1 }), make({ chatId: 2 }))).toBe(false)
  })

  it('refuses a different forum thread', () => {
    // threadId drives the allot settle and machine routing
    expect(canMergeInto(make({ threadId: 11 }), make({ threadId: 22 }))).toBe(false)
    expect(canMergeInto(make({ threadId: undefined }), make({ threadId: 22 }))).toBe(false)
  })

  it('refuses an item that carries its own response channel', () => {
    // Jarvis enqueues with chatId = ADMIN_CHAT_ID plus a dashboardCommandId, so
    // it would otherwise merge with the admin's Telegram messages and be dropped
    expect(canMergeInto(make({}), make({ dashboardCommandId: 'jarvis-1' }))).toBe(false)
  })

  it('refuses to absorb into an item that has its own response channel', () => {
    expect(canMergeInto(make({ dashboardCommandId: 'dash-1' }), make({}))).toBe(false)
  })

  it('refuses when both have channels', () => {
    expect(
      canMergeInto(make({ dashboardCommandId: 'a' }), make({ dashboardCommandId: 'b' })),
    ).toBe(false)
  })
})
