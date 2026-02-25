import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface ActivityEvent {
  readonly timestamp: number
  readonly type: 'prompt_complete'
  readonly project: string
  readonly backend: string
  readonly model: string
  readonly durationMs: number
  readonly costUsd: number
  readonly toolCount: number
  readonly promptLength: number
}

const ACTIVITY_DIR = resolve('data/activity')

function getLogPath(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return resolve(ACTIVITY_DIR, `${yyyy}-${mm}.jsonl`)
}

function ensureDir(): void {
  if (!existsSync(ACTIVITY_DIR)) {
    mkdirSync(ACTIVITY_DIR, { recursive: true })
  }
}

export function recordActivity(event: ActivityEvent): void {
  ensureDir()
  const path = getLogPath(new Date(event.timestamp))
  appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8')
}

export function readActivities(since: number, until?: number): readonly ActivityEvent[] {
  ensureDir()
  const end = until ?? Date.now()
  const events: ActivityEvent[] = []

  // Determine which monthly files to scan
  const start = new Date(since)
  const finish = new Date(end)
  const months: string[] = []

  const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  while (cursor <= finish) {
    months.push(getLogPath(cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }

  for (const filePath of months) {
    if (!existsSync(filePath)) continue
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ActivityEvent
          if (event.timestamp >= since && event.timestamp <= end) {
            events.push(event)
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return events
}

// Convenience: get today's start timestamp
export function todayStart(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

// Get start of N days ago
export function daysAgo(n: number): number {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
