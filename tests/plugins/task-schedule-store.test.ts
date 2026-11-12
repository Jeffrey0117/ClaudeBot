import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regression: the /task schedule plugin and the task-memory store
// (src/bot/task-store.ts) both wrote data/tasks.json with different shapes.
// The scheduler then threw "items is not iterable" every minute, and a
// plugin save would have overwritten the task memory wholesale.

const TASK_MEMORY_SHAPE = {
  'C:\\some\\project': {
    id: '2026-11-09T01-44-43-107Z',
    title: 'a task-memory entry, not a schedule',
    status: 'open',
    decisions: [],
  },
}

let dir = ''

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function loadPluginStoreIn(cwd: string): Promise<typeof import('../../src/plugins/task/task-store.js')> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  vi.resetModules()
  return import('../../src/plugins/task/task-store.js')
}

describe('task schedule plugin store', () => {
  it('does not read the task-memory file as schedule data', async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-sched-'))
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'tasks.json'), JSON.stringify(TASK_MEMORY_SHAPE), 'utf-8')

    const store = await loadPluginStoreIn(dir)

    expect(() => store.getAllPendingTasks()).not.toThrow()
    expect(store.getAllPendingTasks()).toEqual([])
  })

  it('does not overwrite the task-memory file when a schedule is added', async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-sched-'))
    mkdirSync(join(dir, 'data'))
    const memoryFile = join(dir, 'data', 'tasks.json')
    writeFileSync(memoryFile, JSON.stringify(TASK_MEMORY_SHAPE), 'utf-8')

    const store = await loadPluginStoreIn(dir)
    store.addTask(123, 'write report', '09:00')

    expect(JSON.parse(readFileSync(memoryFile, 'utf-8'))).toEqual(TASK_MEMORY_SHAPE)
    expect(store.getTodayTasks(123)).toHaveLength(1)
  })

  it('ignores malformed entries instead of crashing the scheduler', async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-sched-'))
    mkdirSync(join(dir, 'data'))
    writeFileSync(
      join(dir, 'data', 'task-schedule.json'),
      JSON.stringify({ '123': { not: 'an array' } }),
      'utf-8',
    )

    const store = await loadPluginStoreIn(dir)

    expect(store.getAllPendingTasks()).toEqual([])
  })
})
