import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { ProjectInfo } from '../types/index.js'

const MAX_BOOKMARKS = 9
const DATA_PATH = resolve('data/bookmarks.json')

type BookmarkData = Record<string, ProjectInfo[]>

let cache: BookmarkData | null = null

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function load(): BookmarkData {
  if (cache) return cache

  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    cache = JSON.parse(raw) as BookmarkData
  } catch {
    cache = {}
  }

  return cache
}

function save(data: BookmarkData): void {
  ensureDir()
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8')
  cache = data
}

export function getBookmarks(chatId: number): readonly ProjectInfo[] {
  const data = load()
  return data[String(chatId)] ?? []
}

export function addBookmark(chatId: number, project: ProjectInfo): number | null {
  const data = load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]

  if (list.length >= MAX_BOOKMARKS) return null
  if (list.some((b) => b.path === project.path)) return null

  list.push({ name: project.name, path: project.path })
  save({ ...data, [key]: list })
  return list.length
}

export function removeBookmark(chatId: number, slot: number): boolean {
  const data = load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]
  const index = slot - 1

  if (index < 0 || index >= list.length) return false

  list.splice(index, 1)
  save({ ...data, [key]: list })
  return true
}

export function getBookmark(chatId: number, slot: number): ProjectInfo | null {
  const bookmarks = getBookmarks(chatId)
  const index = slot - 1
  if (index < 0 || index >= bookmarks.length) return null
  return bookmarks[index] ?? null
}
