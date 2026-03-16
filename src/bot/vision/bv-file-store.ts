/**
 * Temporary file store for /bv web agent file uploads.
 *
 * Per-chat in-memory store. Files auto-expire after 10 minutes.
 * Max 5 files per chat. Expired files are unlinked from disk.
 */

import { unlink } from 'node:fs/promises'

export interface BvFile {
  readonly path: string
  readonly originalName: string
  readonly mimeType: string
  readonly timestamp: number
}

const MAX_FILES_PER_CHAT = 5
const TTL_MS = 10 * 60 * 1000

const store = new Map<number, BvFile[]>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function addBvFile(chatId: number, file: BvFile): void {
  const files = store.get(chatId) ?? []

  // Evict oldest if at capacity
  if (files.length >= MAX_FILES_PER_CHAT) {
    const evicted = files.shift()
    if (evicted) unlinkQuiet(evicted.path)
  }

  store.set(chatId, [...files, file])
  resetTimer(chatId)
}

export function getBvFiles(chatId: number): readonly BvFile[] {
  const files = store.get(chatId)
  if (!files || files.length === 0) return []

  // Filter out expired individual files
  const now = Date.now()
  const valid = files.filter((f) => now - f.timestamp < TTL_MS)

  if (valid.length !== files.length) {
    const expired = files.filter((f) => now - f.timestamp >= TTL_MS)
    for (const f of expired) unlinkQuiet(f.path)
    store.set(chatId, valid)
  }

  return valid
}

export function clearBvFiles(chatId: number): void {
  const files = store.get(chatId)
  if (files) {
    for (const f of files) unlinkQuiet(f.path)
  }
  store.delete(chatId)
  const timer = timers.get(chatId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(chatId)
  }
}

function resetTimer(chatId: number): void {
  const existing = timers.get(chatId)
  if (existing) clearTimeout(existing)

  timers.set(
    chatId,
    setTimeout(() => clearBvFiles(chatId), TTL_MS),
  )
}

function unlinkQuiet(filePath: string): void {
  unlink(filePath).catch(() => {})
}
