/**
 * Virtual chat store — maps Electron clientIds to stable virtual chatIds.
 *
 * Virtual chatIds use a distinct range that cannot collide with Telegram IDs:
 * - Telegram users: positive numbers
 * - Telegram groups: -1 to -999_999_999
 * - Telegram supergroups/channels: -100_XXXXXXXXXX (starts with -100)
 * - Our virtual range: -2_000_000_001 to -2_009_000_000 (safe gap)
 *
 * Same clientId always maps to the same chatId so state persists across reconnects.
 */

import { resolve } from 'node:path'
import { createJsonFileStore } from '../utils/json-file-store.js'

/** Base offset for virtual chatIds — safely outside Telegram's range. */
const VIRTUAL_BASE = -2_000_000_000

interface VirtualChatEntry {
  readonly virtualChatId: number
  readonly pairingCode: string
  readonly createdAt: number
  readonly lastSeen: number
}

type VirtualChatData = Record<string, VirtualChatEntry>

const store = createJsonFileStore<VirtualChatData>(
  resolve('data/virtual-chats.json'),
  () => ({}),
)

/** Set of known virtual chatIds for O(1) lookup. */
const virtualChatIds = new Set<number>()

/** Load existing virtual chatIds into the lookup set. */
function ensureLoaded(): void {
  if (virtualChatIds.size > 0) return
  const data = store.load()
  for (const entry of Object.values(data)) {
    virtualChatIds.add(entry.virtualChatId)
  }
}

/**
 * Deterministic virtual chatId from clientId, with collision detection.
 * Generates in the range [VIRTUAL_BASE - 9_000_000, VIRTUAL_BASE - 1].
 */
function generateVirtualChatId(clientId: string, data: VirtualChatData): number {
  let hash = 0
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0
  }
  const positive = (Math.abs(hash) % 9_000_000) + 1
  let candidate = VIRTUAL_BASE - positive

  // Collision detection: if another clientId already has this chatId, offset
  const existingIds = new Set(Object.values(data).map((e) => e.virtualChatId))
  let attempts = 0
  while (existingIds.has(candidate) && attempts < 100) {
    candidate = VIRTUAL_BASE - (((positive + attempts + 1) % 9_000_000) + 1)
    attempts++
  }

  return candidate
}

/** Get or create a virtual chatId for a clientId. */
export function getOrCreateVirtualChat(clientId: string, pairingCode: string): number {
  ensureLoaded()
  const data = store.load()
  const existing = data[clientId]

  if (existing) {
    store.save({
      ...data,
      [clientId]: { ...existing, pairingCode, lastSeen: Date.now() },
    })
    return existing.virtualChatId
  }

  const virtualChatId = generateVirtualChatId(clientId, data)
  virtualChatIds.add(virtualChatId)
  store.save({
    ...data,
    [clientId]: {
      virtualChatId,
      pairingCode,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    },
  })
  return virtualChatId
}

/** Check if a chatId is a virtual (Electron) chat via registry lookup. */
export function isVirtualChat(chatId: number): boolean {
  ensureLoaded()
  return virtualChatIds.has(chatId)
}
