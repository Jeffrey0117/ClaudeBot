/**
 * Stores recent user messages per chat for /last re-send.
 * In-memory only — no need to persist across restarts.
 */

const MAX_HISTORY = 5

interface StoredMessage {
  readonly text: string
  readonly timestamp: number
}

/** Key: chatId → recent messages (newest last) */
const history = new Map<string, StoredMessage[]>()

export function recordUserMessage(chatId: number, text: string): void {
  const key = String(chatId)
  const list = history.get(key) ?? []
  const updated = [...list, { text, timestamp: Date.now() }].slice(-MAX_HISTORY)
  history.set(key, updated)
}

/**
 * Get a recent message by 1-based index (1 = most recent).
 * Returns null if not found.
 */
export function getRecentMessage(chatId: number, index: number): string | null {
  const key = String(chatId)
  const list = history.get(key)
  if (!list || list.length === 0) return null
  const i = list.length - index
  if (i < 0) return null
  return list[i].text
}
