import { resolve } from 'node:path'
import type { ProjectInfo } from '../types/index.js'
import { createJsonFileStore } from '../utils/json-file-store.js'

const MAX_BOOKMARKS = 9

type BookmarkData = Record<string, ProjectInfo[]>

const store = createJsonFileStore<BookmarkData>(resolve('data/bookmarks.json'), () => ({}))

export function getBookmarks(chatId: number): readonly ProjectInfo[] {
  const data = store.load()
  return data[String(chatId)] ?? []
}

export function addBookmark(chatId: number, project: ProjectInfo): number | null {
  const data = store.load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]

  if (list.length >= MAX_BOOKMARKS) return null
  if (list.some((b) => b.path === project.path)) return null

  list.push({ name: project.name, path: project.path })
  store.save({ ...data, [key]: list })
  return list.length
}

export function removeBookmark(chatId: number, slot: number): boolean {
  const data = store.load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]
  const index = slot - 1

  if (index < 0 || index >= list.length) return false

  list.splice(index, 1)
  store.save({ ...data, [key]: list })
  return true
}

export function getBookmark(chatId: number, slot: number): ProjectInfo | null {
  const bookmarks = getBookmarks(chatId)
  const index = slot - 1
  if (index < 0 || index >= bookmarks.length) return null
  return bookmarks[index] ?? null
}

export function addBookmarkAt(chatId: number, project: ProjectInfo, slot: number): boolean {
  const data = store.load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]

  if (list.some((b) => b.path === project.path)) return false
  if (slot < 1 || slot > MAX_BOOKMARKS) return false

  const index = slot - 1
  // Pad with nulls if needed, then insert
  while (list.length < index) {
    list.push(null as unknown as ProjectInfo)
  }
  list.splice(index, 0, { name: project.name, path: project.path })

  // Trim to max and remove trailing nulls
  const trimmed = list.slice(0, MAX_BOOKMARKS).filter(Boolean)
  store.save({ ...data, [key]: trimmed })
  return true
}

export function swapBookmarks(chatId: number, slotA: number, slotB: number): boolean {
  const data = store.load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]

  const idxA = slotA - 1
  const idxB = slotB - 1
  if (idxA < 0 || idxA >= list.length) return false
  if (idxB < 0 || idxB >= list.length) return false
  if (idxA === idxB) return false

  const temp = list[idxA]
  list[idxA] = list[idxB]
  list[idxB] = temp

  store.save({ ...data, [key]: list })
  return true
}
