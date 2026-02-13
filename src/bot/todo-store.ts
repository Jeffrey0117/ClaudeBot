import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface TodoItem {
  readonly text: string
  readonly createdAt: string
  readonly done: boolean
}

const DATA_PATH = resolve('data/todos.json')

type TodoData = Record<string, TodoItem[]>

let cache: TodoData | null = null

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function load(): TodoData {
  if (cache) return cache

  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    cache = JSON.parse(raw) as TodoData
  } catch {
    cache = {}
  }

  return cache
}

function save(data: TodoData): void {
  ensureDir()
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8')
  cache = data
}

export function addTodo(projectPath: string, text: string): TodoItem {
  const data = load()
  const list = [...(data[projectPath] ?? [])]
  const item: TodoItem = { text, createdAt: new Date().toISOString(), done: false }
  list.push(item)
  save({ ...data, [projectPath]: list })
  return item
}

export function getTodos(projectPath: string): readonly TodoItem[] {
  const data = load()
  return data[projectPath] ?? []
}

export function toggleTodo(projectPath: string, index: number): boolean {
  const data = load()
  const list = [...(data[projectPath] ?? [])]

  if (index < 0 || index >= list.length) return false

  const item = list[index]
  list[index] = { ...item, done: !item.done }
  save({ ...data, [projectPath]: list })
  return true
}

export function clearDone(projectPath: string): number {
  const data = load()
  const list = data[projectPath] ?? []
  const remaining = list.filter((item) => !item.done)
  const cleared = list.length - remaining.length

  if (cleared > 0) {
    save({ ...data, [projectPath]: remaining })
  }

  return cleared
}
