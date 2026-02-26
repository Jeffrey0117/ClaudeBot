import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface TaskItem {
  readonly id: string
  readonly chatId: number
  readonly text: string
  readonly startTime: string    // "HH:MM"
  readonly endTime?: string     // "HH:MM" (optional)
  readonly done: boolean
  readonly date: string         // "YYYY-MM-DD"
  readonly createdAt: string    // ISO
  readonly notifiedStart: boolean
  readonly notifiedEnd: boolean
}

const DATA_PATH = resolve('data/tasks.json')

type TaskData = Record<string, TaskItem[]>

let cache: TaskData | null = null

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function load(): TaskData {
  if (cache) return cache

  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    cache = JSON.parse(raw) as TaskData
  } catch {
    cache = {}
  }

  return cache
}

function save(data: TaskData): void {
  ensureDir()
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8')
  cache = data
}

function chatKey(chatId: number): string {
  return String(chatId)
}

function todayStr(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addTask(chatId: number, text: string, startTime: string, endTime?: string): TaskItem {
  const data = load()
  const key = chatKey(chatId)
  const list = [...(data[key] ?? [])]

  const item: TaskItem = {
    id: `t-${Date.now()}`,
    chatId,
    text,
    startTime,
    endTime,
    done: false,
    date: todayStr(),
    createdAt: new Date().toISOString(),
    notifiedStart: false,
    notifiedEnd: false,
  }

  list.push(item)
  save({ ...data, [key]: list })
  return item
}

export function getTodayTasks(chatId: number): readonly TaskItem[] {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []
  const today = todayStr()
  return all.filter((t) => t.date === today)
}

export function getAllPendingTasks(): readonly TaskItem[] {
  const data = load()
  const today = todayStr()
  const result: TaskItem[] = []

  for (const items of Object.values(data)) {
    for (const t of items) {
      if (t.date === today && !t.done) {
        result.push(t)
      }
    }
  }

  return result
}

export function toggleTask(chatId: number, index: number): TaskItem | null {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []
  const today = todayStr()
  const todayTasks = all.filter((t) => t.date === today)

  if (index < 0 || index >= todayTasks.length) return null

  const target = todayTasks[index]
  const updatedList = all.map((t) =>
    t.id === target.id ? { ...t, done: !t.done } : t
  )

  save({ ...data, [key]: updatedList })
  return { ...target, done: !target.done }
}

export function removeTask(chatId: number, index: number): TaskItem | null {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []
  const today = todayStr()
  const todayTasks = all.filter((t) => t.date === today)

  if (index < 0 || index >= todayTasks.length) return null

  const target = todayTasks[index]
  const updatedList = all.filter((t) => t.id !== target.id)

  save({ ...data, [key]: updatedList })
  return target
}

export function clearTodayTasks(chatId: number): number {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []
  const today = todayStr()
  const remaining = all.filter((t) => t.date !== today)
  const cleared = all.length - remaining.length

  if (cleared > 0) {
    save({ ...data, [key]: remaining })
  }

  return cleared
}

export function markNotified(chatId: number, taskId: string, field: 'notifiedStart' | 'notifiedEnd'): void {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []

  const updatedList = all.map((t) =>
    t.id === taskId ? { ...t, [field]: true } : t
  )

  save({ ...data, [key]: updatedList })
}

export function markTaskDoneById(chatId: number, taskId: string): void {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []

  const updatedList = all.map((t) =>
    t.id === taskId ? { ...t, done: true } : t
  )

  save({ ...data, [key]: updatedList })
}

export function extendTask(chatId: number, taskId: string, minutes: number): TaskItem | null {
  const data = load()
  const key = chatKey(chatId)
  const all = data[key] ?? []
  const target = all.find((t) => t.id === taskId)

  if (!target || !target.endTime) return null

  const [h, m] = target.endTime.split(':').map(Number)
  const totalMins = h * 60 + m + minutes
  const newH = Math.floor(totalMins / 60) % 24
  const newM = totalMins % 60
  const newEndTime = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`

  const updatedList = all.map((t) =>
    t.id === taskId ? { ...t, endTime: newEndTime, notifiedEnd: false } : t
  )

  save({ ...data, [key]: updatedList })
  return { ...target, endTime: newEndTime, notifiedEnd: false }
}
