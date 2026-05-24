import { resolve } from 'node:path'
import { createJsonFileStore } from '../utils/json-file-store.js'

export interface PinItem {
  readonly text: string
  readonly createdAt: string
  readonly lastUsed?: string
  readonly hitCount?: number
  readonly validUntil?: string
}

const MAX_PINS = 10
const STALE_DAYS = 7

type PinData = Record<string, PinItem[]>

const store = createJsonFileStore<PinData>(resolve('data/context-pins.json'), () => ({}))

export function addPin(projectPath: string, text: string): PinItem | null {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  if (list.length >= MAX_PINS) return null

  const now = new Date().toISOString()
  const item: PinItem = { text, createdAt: now, lastUsed: now, hitCount: 0 }
  list.push(item)
  store.save({ ...data, [projectPath]: list })
  return item
}

export function getPins(projectPath: string): readonly PinItem[] {
  const data = store.load()
  return data[projectPath] ?? []
}

export function removePin(projectPath: string, index: number): boolean {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  if (index < 0 || index >= list.length) return false

  list.splice(index, 1)
  store.save({ ...data, [projectPath]: list })
  return true
}

export function updatePin(projectPath: string, index: number, text: string): boolean {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  if (index < 0 || index >= list.length) return false

  const existing = list[index]
  list[index] = {
    ...existing,
    text,
    lastUsed: new Date().toISOString(),
    hitCount: (existing.hitCount ?? 0) + 1,
  }
  store.save({ ...data, [projectPath]: list })
  return true
}

export function clearPins(projectPath: string): number {
  const data = store.load()
  const list = data[projectPath] ?? []
  const count = list.length

  if (count > 0) {
    store.save({ ...data, [projectPath]: [] })
  }

  return count
}

/** Increment hitCount + update lastUsed for all pins (called on injection). */
export function touchPins(projectPath: string): void {
  const data = store.load()
  const list = data[projectPath] ?? []
  if (list.length === 0) return

  const now = new Date().toISOString()
  const updated = list.map((p) => ({
    ...p,
    lastUsed: now,
    hitCount: (p.hitCount ?? 0) + 1,
  }))
  store.save({ ...data, [projectPath]: updated })
}

export function formatPinsForPrompt(projectPath: string): string {
  const pins = getPins(projectPath)
  if (pins.length === 0) return ''

  const now = Date.now()
  const lines = pins.map((p, i) => {
    const lastUsed = p.lastUsed ? new Date(p.lastUsed).getTime() : now
    const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24)
    const staleTag = daysSinceUse >= STALE_DAYS ? ' ⚠️可能過時' : ''
    return `${i + 1}. ${p.text}${staleTag}`
  })
  return `[\u{91D8}\u{9078}\u{4E0A}\u{4E0B}\u{6587}]\n${lines.join('\n')}\n` +
    `你可以用 @pin(文字) 自動釘選、@unpin(N) 移除、@pin_update(N, 文字) 更新。上限 ${MAX_PINS} 則。\n` +
    `[/\u{91D8}\u{9078}\u{4E0A}\u{4E0B}\u{6587}]`
}
