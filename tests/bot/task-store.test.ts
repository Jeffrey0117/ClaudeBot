import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import {
  recordTurn,
  getTask,
  clearTask,
  buildTaskInjection,
  taskFilePath,
} from '../../src/bot/task-store.js'
import type { ContextDigest } from '../../src/bot/context-digest-store.js'

let seq = 0
const proj = (tag: string): string => `C:/tmp/task-${tag}-${Date.now()}-${seq++}`

function digest(over: Partial<ContextDigest> = {}): ContextDigest {
  return {
    status: 'info',
    summary: 'did a thing',
    pending: 'none',
    next: 'none',
    files: [],
    ...over,
  }
}

describe('task store', () => {
  it('opens a task from the first turn and titles it with the first summary', () => {
    const p = proj('open')
    recordTurn(p, digest({ summary: '改好 splitText 的 fence 保留量' }))
    const t = getTask(p)
    expect(t?.status).toBe('open')
    expect(t?.title).toBe('改好 splitText 的 fence 保留量')
    expect(t?.decisions).toHaveLength(1)
    clearTask(p)
  })

  it('appends decisions instead of overwriting them', () => {
    const p = proj('append')
    recordTurn(p, digest({ summary: '決定 A' }))
    recordTurn(p, digest({ summary: '決定 B' }))
    recordTurn(p, digest({ summary: '決定 C' }))
    const t = getTask(p)
    expect(t?.decisions.map((d) => d.text)).toEqual(['決定 A', '決定 B', '決定 C'])
    clearTask(p)
  })

  it('tracks current state and accumulates touched files without duplicates', () => {
    const p = proj('state')
    recordTurn(p, digest({ pending: '等使用者決定', next: '跑測試', files: ['a.ts', 'b.ts'] }))
    recordTurn(p, digest({ pending: 'none', next: '部署', files: ['b.ts', 'c.ts'] }))
    const t = getTask(p)
    expect(t?.open).toBe('') // 'none' means nothing outstanding
    expect(t?.next).toBe('部署')
    expect([...(t?.files ?? [])].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
    clearTask(p)
  })

  it('starts a NEW task after one is done, so logs do not bleed together', () => {
    const p = proj('boundary')
    recordTurn(p, digest({ summary: '任務一的決定' }))
    recordTurn(p, digest({ summary: '任務一完成', status: 'done' }))
    expect(getTask(p)?.status).toBe('done')

    recordTurn(p, digest({ summary: '任務二的決定' }))
    const t = getTask(p)
    expect(t?.status).toBe('open')
    expect(t?.title).toBe('任務二的決定')
    expect(t?.decisions.map((d) => d.text)).toEqual(['任務二的決定'])
    clearTask(p)
  })

  /**
   * The whole point: the prompt cost must not grow with the task. Decisions
   * accumulate on disk; the injection stays a fixed shape with a path to the
   * rest.
   */
  it('keeps the injection bounded as the task grows', () => {
    const p = proj('bounded')
    for (let i = 0; i < 3; i++) recordTurn(p, digest({ summary: `決定 ${i}` }))
    const small = buildTaskInjection(p)

    for (let i = 3; i < 30; i++) recordTurn(p, digest({ summary: `決定 ${i}` }))
    const big = buildTaskInjection(p)

    expect(getTask(p)?.decisions.length).toBe(30)
    // 27 more decisions must not mean a materially bigger prompt
    expect(big.length).toBeLessThan(small.length + 200)
    // and it must tell the model where the rest is
    expect(big).toContain(taskFilePath(p))
    clearTask(p)
  })

  it('writes a readable .md mirror', () => {
    const p = proj('md')
    recordTurn(p, digest({ summary: '可讀的決定', next: '下一步' }))
    const f = taskFilePath(p)
    expect(existsSync(f)).toBe(true)
    const md = readFileSync(f, 'utf-8')
    expect(md).toContain('可讀的決定')
    expect(md).toContain('## decisions')
    clearTask(p)
  })

  it('clearTask removes it (so /new really starts over)', () => {
    const p = proj('clear')
    recordTurn(p, digest())
    expect(getTask(p)).not.toBeNull()
    clearTask(p)
    expect(getTask(p)).toBeNull()
    expect(buildTaskInjection(p)).toBe('')
  })

  it('injects nothing for a project with no task', () => {
    expect(buildTaskInjection(proj('empty'))).toBe('')
  })
})
