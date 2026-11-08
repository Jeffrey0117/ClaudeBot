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
// Not pretty-printed: at the 10k cap the indentation alone is most of a
// multi-megabyte write, and nothing reads this file by eye.
const store = createJsonFileStore<VaultData>(STORE_PATH, () => ({ entries: [] }), { pretty: false })

const MAX_ENTRIES = 10000
/** Batch window for index writes. */
const FLUSH_MS = 1_000

/**
 * Entries indexed but not yet written.
 *
 * addEntry runs on EVERY inbound message (and every bot reply), and it used to
 * do a full synchronous rewrite of the whole index each time — at the 10k cap
 * that is a multi-megabyte JSON.stringify + writeFileSync blocking the event
 * loop, which stalls Telegram polling and the response-broker tick. Writes are
 * now batched; reads still see pending entries immediately.
 */
let pending: IndexEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

const keyOf = (e: IndexEntry): string => `${e.chatId}:${e.messageId}`

/**
 * Persisted entries plus anything still queued.
 *
 * There used to be a module-level `entriesCache` populated once and never
 * re-read, which defeated the mtime invalidation json-file-store provides
 * specifically for the multi-process case: each bot held a stale snapshot and
 * each save() wrote its own full array, so the last writer silently deleted
 * everything its siblings had indexed. Relying on store.load() fixes that —
 * it only re-parses when the file actually changed.
 */
function getEntries(): IndexEntry[] {
  const persisted = store.load().entries
  return pending.length === 0 ? persisted : [...persisted, ...pending]
}

function flushPending(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pending.length === 0) return

  const batch = pending
  pending = []

  const persisted = store.load().entries
  const seen = new Set(persisted.map(keyOf))
  const fresh: IndexEntry[] = []
  for (const e of batch) {
    const k = keyOf(e)
    if (seen.has(k)) continue
    seen.add(k)
    fresh.push(e)
  }
  if (fresh.length === 0) return

  const updated = [...persisted, ...fresh]
  // Cap at MAX_ENTRIES — remove oldest
  if (updated.length > MAX_ENTRIES) {
    updated.splice(0, updated.length - MAX_ENTRIES)
  }
  store.save({ entries: updated })
}

function saveEntries(entries: IndexEntry[]): void {
  // Callers build `entries` from getEntries(), which already folds in pending,
  // so the queued batch is represented here — drop it instead of writing twice.
  pending = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  store.save({ entries })
}

// --- Public API ---

export function addEntry(entry: IndexEntry): void {
  const k = keyOf(entry)

  // Skip if already indexed (queued or persisted)
  if (pending.some(e => keyOf(e) === k)) return
  if (store.load().entries.some(e => keyOf(e) === k)) return

  pending.push(entry)
  if (!flushTimer) {
    flushTimer = setTimeout(flushPending, FLUSH_MS)
    flushTimer.unref?.()
  }
}

/** Write any queued entries now (e.g. before reporting stats). */
export function flushIndex(): void {
  flushPending()
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
