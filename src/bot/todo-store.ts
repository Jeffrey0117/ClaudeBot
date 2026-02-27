import { resolve } from 'node:path'
import { createJsonFileStore } from '../utils/json-file-store.js'

export interface TodoItem {
  readonly text: string
  readonly createdAt: string
  readonly done: boolean
}

type TodoData = Record<string, TodoItem[]>

const store = createJsonFileStore<TodoData>(resolve('data/todos.json'), () => ({}))

export function addTodo(projectPath: string, text: string): TodoItem {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]
  const item: TodoItem = { text, createdAt: new Date().toISOString(), done: false }
  list.push(item)
  store.save({ ...data, [projectPath]: list })
  return item
}

export function getTodos(projectPath: string): readonly TodoItem[] {
  const data = store.load()
  return data[projectPath] ?? []
}

export function toggleTodo(projectPath: string, index: number): boolean {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  if (index < 0 || index >= list.length) return false

  const item = list[index]
  list[index] = { ...item, done: !item.done }
  store.save({ ...data, [projectPath]: list })
  return true
}

export interface ProjectTodos {
  readonly projectPath: string
  readonly items: readonly TodoItem[]
}

/** Get todos across ALL projects (for /todos all). */
export function getAllTodos(): readonly ProjectTodos[] {
  const data = store.load()
  return Object.entries(data)
    .filter(([, items]) => items.length > 0)
    .map(([projectPath, items]) => ({ projectPath, items }))
}

export function clearDone(projectPath: string): number {
  const data = store.load()
  const list = data[projectPath] ?? []
  const remaining = list.filter((item) => !item.done)
  const cleared = list.length - remaining.length

  if (cleared > 0) {
    store.save({ ...data, [projectPath]: remaining })
  }

  return cleared
}
