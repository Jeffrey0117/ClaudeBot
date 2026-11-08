import { describe, it, expect, beforeEach } from 'vitest'
import {
  enqueue,
  setProcessor,
  setSlotNotify,
  setCompletionHook,
  getRunningCount,
  getWaitingForSlotCount,
} from '../../src/claude/queue.js'
import { env } from '../../src/config/env.js'
import type { QueueItem } from '../../src/types/index.js'

/**
 * `remote:` paths skip the cross-process file lock, so these tests exercise the
 * concurrency cap without touching the filesystem.
 */
function remoteItem(tag: string, chatId = 1): QueueItem {
  const path = `remote:${tag}`
  return {
    chatId,
    prompt: `prompt-${tag}`,
    project: { name: tag, path },
    ai: { backend: 'claude', model: 'sonnet' },
    sessionId: null,
    imagePaths: [],
  }
}

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

let unique = 0
const tagFor = (): string => `cap-${Date.now()}-${unique++}`

describe('queue global concurrency cap', () => {
  beforeEach(() => {
    setSlotNotify(() => {})
    setCompletionHook(() => {})
  })

  it('never runs more turns at once than MAX_PARALLEL', async () => {
    const max = env.MAX_PARALLEL
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []

    setProcessor(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
    })

    const total = max + 3
    for (let i = 0; i < total; i++) enqueue(remoteItem(tagFor()))
    await tick()

    expect(peak).toBe(max)
    expect(getRunningCount()).toBe(max)
    expect(getWaitingForSlotCount()).toBe(total - max)

    // Drain everything; each release must let exactly one waiter in
    while (releases.length > 0 || getRunningCount() > 0) {
      const next = releases.shift()
      if (!next) break
      next()
      await tick()
    }

    expect(peak).toBe(max)
    expect(getRunningCount()).toBe(0)
    expect(getWaitingForSlotCount()).toBe(0)
  })

  it('runs every queued turn eventually — no starvation', async () => {
    const seen: string[] = []
    setProcessor(async (item) => {
      seen.push(item.prompt)
    })

    const total = env.MAX_PARALLEL + 4
    const tags = Array.from({ length: total }, () => tagFor())
    for (const t of tags) enqueue(remoteItem(t))
    await tick(40)

    expect(seen.length).toBe(total)
    for (const t of tags) expect(seen).toContain(`prompt-${t}`)
    expect(getRunningCount()).toBe(0)
  })

  it('tells the user when their turn is queued behind the cap', async () => {
    const notices: Array<{ name: string; ahead: number }> = []
    setSlotNotify((_chatId, projectName, ahead) => {
      notices.push({ name: projectName, ahead })
    })

    const releases: Array<() => void> = []
    setProcessor(async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
    })

    const max = env.MAX_PARALLEL
    const tags = Array.from({ length: max + 2 }, () => tagFor())
    for (const t of tags) enqueue(remoteItem(t))
    await tick()

    // exactly the overflow turns are told, and they are told how many are ahead
    expect(notices.length).toBe(2)
    for (const n of notices) expect(n.ahead).toBe(max)

    while (releases.length > 0) {
      releases.shift()!()
      await tick()
    }
  })

  it('does not notify when a slot is free', async () => {
    const notices: number[] = []
    setSlotNotify((_c, _n, ahead) => notices.push(ahead))
    setProcessor(async () => {})

    enqueue(remoteItem(tagFor()))
    await tick(20)

    expect(notices).toEqual([])
    expect(getRunningCount()).toBe(0)
  })
})
