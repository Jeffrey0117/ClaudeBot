/**
 * Vault Index Store
 *
 * Lightweight metadata index for Telegram messages.
 * Actual content stays in Telegram — we only store pointers + metadata.
 * Designed for fast lookup by ID, tag, or time range.
 */

import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'

// --- Types ---

export interface IndexEntry {
  readonly messageId: number
  readonly chatId: number
  readonly type: 'text' | 'voice' | 'photo' | 'document' | 'video' | 'sticker' | 'other'
  readonly timestamp: number
  readonly fromBot: boolean
  readonly preview: string          // first 100 chars of text, or filename, or "[voice]"
  readonly tags: readonly string[]
  readonly voiceFileId?: string     // for re-downloading voice later
  readonly fileId?: string          // for documents/photos
  readonly replyToId?: number       // which message this replies to
}

interface VaultData {
  entries: IndexEntry[]
}

// --- Store ---

const STORE_PATH = resolve('data/vault-index.json')
const store = createJsonFileStore<VaultData>(STORE_PATH, () => ({ entries: [] }))

// In-memory cache for fast lookups
let entriesCache: IndexEntry[] | null = null

function getEntries(): IndexEntry[] {
  if (!entriesCache) {
    entriesCache = [...store.load().entries]
  }
  return entriesCache
}

function saveEntries(entries: IndexEntry[]): void {
  entriesCache = entries
  store.save({ entries })
}

// --- Public API ---

export function addEntry(entry: IndexEntry): void {
  const entries = getEntries()

  // Skip if already indexed
  if (entries.some(e => e.messageId === entry.messageId && e.chatId === entry.chatId)) {
    return
  }

  const updated = [...entries, entry]

  // Cap at 10000 entries — remove oldest
  if (updated.length > 10000) {
    updated.splice(0, updated.length - 10000)
  }

  saveEntries(updated)
}

export function getEntryById(chatId: number, messageId: number): IndexEntry | null {
  return getEntries().find(e => e.chatId === chatId && e.messageId === messageId) ?? null
}

export function getRecentEntries(chatId: number, limit: number = 20): readonly IndexEntry[] {
  return getEntries()
    .filter(e => e.chatId === chatId)
    .slice(-limit)
}

export function searchEntries(chatId: number, query: string): readonly IndexEntry[] {
  const lower = query.toLowerCase()
  return getEntries().filter(e =>
    e.chatId === chatId &&
    (e.preview.toLowerCase().includes(lower) ||
     e.tags.some(t => t.toLowerCase().includes(lower)))
  )
}

export function getEntriesByTag(chatId: number, tag: string): readonly IndexEntry[] {
  const lower = tag.toLowerCase()
  return getEntries().filter(e =>
    e.chatId === chatId &&
    e.tags.some(t => t.toLowerCase() === lower)
  )
}

export function addTag(chatId: number, messageId: number, tag: string): boolean {
  const entries = getEntries()
  const idx = entries.findIndex(e => e.chatId === chatId && e.messageId === messageId)
  if (idx === -1) return false

  const entry = entries[idx]
  if (entry.tags.includes(tag)) return true  // already tagged

  const updated = [...entries]
  updated[idx] = { ...entry, tags: [...entry.tags, tag] }
  saveEntries(updated)
  return true
}

export function removeTag(chatId: number, messageId: number, tag: string): boolean {
  const entries = getEntries()
  const idx = entries.findIndex(e => e.chatId === chatId && e.messageId === messageId)
  if (idx === -1) return false

  const entry = entries[idx]
  const updated = [...entries]
  updated[idx] = { ...entry, tags: entry.tags.filter(t => t !== tag) }
  saveEntries(updated)
  return true
}

export function getStats(chatId: number): {
  total: number
  byType: Record<string, number>
  tagged: number
  oldest: number | null
  newest: number | null
} {
  const entries = getEntries().filter(e => e.chatId === chatId)

  const byType: Record<string, number> = {}
  let tagged = 0

  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
    if (e.tags.length > 0) tagged++
  }

  return {
    total: entries.length,
    byType,
    tagged,
    oldest: entries.length > 0 ? entries[0].timestamp : null,
    newest: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
  }
}

export function getVoiceEntries(chatId: number, limit: number = 50): readonly IndexEntry[] {
  return getEntries()
    .filter(e => e.chatId === chatId && e.type === 'voice' && e.voiceFileId)
    .slice(-limit)
}

/** Get entries in a time range (for summary) */
export function getEntriesByTimeRange(
  chatId: number,
  startMs: number,
  endMs: number = Date.now(),
): readonly IndexEntry[] {
  return getEntries().filter(e =>
    e.chatId === chatId &&
    e.timestamp >= startMs &&
    e.timestamp <= endMs
  )
}

/** Get the last N text entries with previews (for context injection) */
export function getRecentTextPreviews(chatId: number, limit: number = 20): readonly IndexEntry[] {
  return getEntries()
    .filter(e => e.chatId === chatId && e.type === 'text' && e.preview.length > 0)
    .slice(-limit)
}
