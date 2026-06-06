import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'

// --- Types ---

export type IgPostStatus = 'pending' | 'posting' | 'done' | 'failed'

export interface IgScheduleEntry {
  readonly id: string
  readonly chatId: number
  readonly datetime: string // ISO format: "2025-04-15T14:00:00"
  readonly filename: string
  readonly caption: string
  readonly status: IgPostStatus
  readonly createdAt: string
  readonly result: { success: boolean; duration_s: number; error?: string } | null
  /** Pairing label of the machine (= IG account) that should post. Optional → active machine. */
  readonly machine?: string
  /** File path relative to the REMOTE machine's ~/Videos (zero-transfer post). */
  readonly remotePath?: string
}

// --- Store ---

const DATA_PATH = resolve('data/ig-schedule.json')
const store = createJsonFileStore<IgScheduleEntry[]>(DATA_PATH, () => [])

/** Max age for completed entries (30 days). */
const MAX_COMPLETED_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function listSchedule(): readonly IgScheduleEntry[] {
  return store.load()
}

export function getPending(): readonly IgScheduleEntry[] {
  return store.load().filter((e) => e.status === 'pending')
}

export function getHistory(): readonly IgScheduleEntry[] {
  return store
    .load()
    .filter((e) => e.status === 'done' || e.status === 'failed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20)
}

export function getEntry(id: string): IgScheduleEntry | null {
  return store.load().find((e) => e.id === id) ?? null
}

export function addEntry(entry: IgScheduleEntry): void {
  const all = store.load()
  store.save([...all, entry])
}

export function updateEntry(id: string, updates: Partial<Pick<IgScheduleEntry, 'status' | 'result'>>): boolean {
  const all = store.load()
  const idx = all.findIndex((e) => e.id === id)
  if (idx === -1) return false

  const updated = all.map((e) =>
    e.id === id ? { ...e, ...updates } : e,
  )
  store.save(updated)
  return true
}

export function cancelEntry(id: string): boolean {
  const all = store.load()
  const entry = all.find((e) => e.id === id)
  if (!entry || entry.status !== 'pending') return false

  store.save(all.filter((e) => e.id !== id))
  return true
}

/** Remove completed entries older than 30 days. */
export function cleanupOldEntries(): number {
  const all = store.load()
  const cutoff = Date.now() - MAX_COMPLETED_AGE_MS
  const kept = all.filter((e) => {
    if (e.status === 'pending' || e.status === 'posting') return true
    const created = new Date(e.createdAt).getTime()
    return created > cutoff
  })
  const removed = all.length - kept.length
  if (removed > 0) {
    store.save(kept)
  }
  return removed
}
