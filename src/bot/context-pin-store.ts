import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface PinItem {
  readonly text: string
  readonly createdAt: string
}

const DATA_PATH = resolve('data/context-pins.json')
const MAX_PINS = 10

type PinData = Record<string, PinItem[]>

let cache: PinData | null = null

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function load(): PinData {
  if (cache) return cache

  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    cache = JSON.parse(raw) as PinData
  } catch {
    cache = {}
  }

  return cache
}

function save(data: PinData): void {
  ensureDir()
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8')
  cache = data
}

export function addPin(projectPath: string, text: string): PinItem | null {
  const data = load()
  const list = [...(data[projectPath] ?? [])]

  if (list.length >= MAX_PINS) return null

  const item: PinItem = { text, createdAt: new Date().toISOString() }
  list.push(item)
  save({ ...data, [projectPath]: list })
  return item
}

export function getPins(projectPath: string): readonly PinItem[] {
  const data = load()
  return data[projectPath] ?? []
}

export function removePin(projectPath: string, index: number): boolean {
  const data = load()
  const list = [...(data[projectPath] ?? [])]

  if (index < 0 || index >= list.length) return false

  list.splice(index, 1)
  save({ ...data, [projectPath]: list })
  return true
}

export function clearPins(projectPath: string): number {
  const data = load()
  const list = data[projectPath] ?? []
  const count = list.length

  if (count > 0) {
    save({ ...data, [projectPath]: [] })
  }

  return count
}

export function formatPinsForPrompt(projectPath: string): string {
  const pins = getPins(projectPath)
  if (pins.length === 0) return ''

  const lines = pins.map((p, i) => `${i + 1}. ${p.text}`)
  return `[釘選上下文]\n${lines.join('\n')}\n[/釘選上下文]`
}
