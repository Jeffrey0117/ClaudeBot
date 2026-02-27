import { resolve } from 'node:path'
import { createJsonFileStore } from '../utils/json-file-store.js'

export interface PinItem {
  readonly text: string
  readonly createdAt: string
}

const MAX_PINS = 10

type PinData = Record<string, PinItem[]>

const store = createJsonFileStore<PinData>(resolve('data/context-pins.json'), () => ({}))

export function addPin(projectPath: string, text: string): PinItem | null {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  if (list.length >= MAX_PINS) return null

  const item: PinItem = { text, createdAt: new Date().toISOString() }
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

export function clearPins(projectPath: string): number {
  const data = store.load()
  const list = data[projectPath] ?? []
  const count = list.length

  if (count > 0) {
    store.save({ ...data, [projectPath]: [] })
  }

  return count
}

export function formatPinsForPrompt(projectPath: string): string {
  const pins = getPins(projectPath)
  if (pins.length === 0) return ''

  const lines = pins.map((p, i) => `${i + 1}. ${p.text}`)
  return `[\u{91D8}\u{9078}\u{4E0A}\u{4E0B}\u{6587}]\n${lines.join('\n')}\n[/\u{91D8}\u{9078}\u{4E0A}\u{4E0B}\u{6587}]`
}
