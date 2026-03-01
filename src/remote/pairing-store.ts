/**
 * File-backed pairing state for remote vibe-coding sessions.
 * Uses a JSON file so all bot processes (main, bot2, bot5, etc.)
 * share the same pairing data — relay runs in main but /pair
 * can be called from any bot instance.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { sessionKey } from '../bot/state.js'

const PAIRING_TTL_MS = 5 * 60 * 1000 // 5 minutes
const STORE_PATH = path.resolve('data', 'pairings.json')

export interface PairingSession {
  readonly code: string
  readonly chatId: number
  readonly threadId: number | undefined
  readonly createdAt: number
  readonly label: string
  readonly connected: boolean
}

interface StoreData {
  /** Key: sessionKey(chatId, threadId) → PairingSession */
  readonly pairings: Record<string, PairingSession>
  /** Reverse lookup: code → sessionKey */
  readonly codeIndex: Record<string, string>
}

function ensureDir(): void {
  mkdirSync(path.dirname(STORE_PATH), { recursive: true })
}

function readStore(): StoreData {
  try {
    const raw = readFileSync(STORE_PATH, 'utf-8')
    return JSON.parse(raw) as StoreData
  } catch {
    return { pairings: {}, codeIndex: {} }
  }
}

function writeStore(data: StoreData): void {
  ensureDir()
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8')
}

function isExpired(session: PairingSession): boolean {
  if (session.connected) return false
  return Date.now() - session.createdAt > PAIRING_TTL_MS
}

export function createPairingCode(
  chatId: number,
  threadId: number | undefined,
): string {
  const key = sessionKey(chatId, threadId)
  const store = readStore()
  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }

  // Remove previous pairing for this chat if any
  const prev = pairings[key]
  if (prev) {
    delete codeIndex[prev.code]
    delete pairings[key]
  }

  // 8-char alphanumeric code (~2^47 possibilities)
  const code = randomBytes(5).toString('base64url').slice(0, 8).toUpperCase()
  const session: PairingSession = {
    code,
    chatId,
    threadId,
    createdAt: Date.now(),
    label: '',
    connected: false,
  }

  pairings[key] = session
  codeIndex[code] = key
  writeStore({ pairings, codeIndex })
  return code
}

export function getPairing(
  chatId: number,
  threadId: number | undefined,
): PairingSession | null {
  const key = sessionKey(chatId, threadId)
  const store = readStore()
  const session = store.pairings[key]
  if (!session) return null
  if (isExpired(session)) {
    // Purge expired
    const pairings = { ...store.pairings }
    const codeIndex = { ...store.codeIndex }
    delete codeIndex[session.code]
    delete pairings[key]
    writeStore({ pairings, codeIndex })
    return null
  }
  return session
}

export function findByCode(code: string): PairingSession | null {
  const store = readStore()
  const key = store.codeIndex[code]
  if (!key) return null
  const session = store.pairings[key]
  if (!session) return null
  if (isExpired(session)) {
    const pairings = { ...store.pairings }
    const codeIndex = { ...store.codeIndex }
    delete codeIndex[code]
    delete pairings[key]
    writeStore({ pairings, codeIndex })
    return null
  }
  return session
}

export function markConnected(code: string, label: string): boolean {
  const store = readStore()
  const key = store.codeIndex[code]
  if (!key) return false
  const session = store.pairings[key]
  if (!session) return false
  const pairings = { ...store.pairings, [key]: { ...session, connected: true, label } }
  writeStore({ pairings, codeIndex: store.codeIndex })
  return true
}

export function markDisconnected(code: string): void {
  const store = readStore()
  const key = store.codeIndex[code]
  if (!key) return
  const session = store.pairings[key]
  if (!session) return
  const pairings = { ...store.pairings, [key]: { ...session, connected: false } }
  writeStore({ pairings, codeIndex: store.codeIndex })
}

export function removePairing(
  chatId: number,
  threadId: number | undefined,
): boolean {
  const key = sessionKey(chatId, threadId)
  const store = readStore()
  const session = store.pairings[key]
  if (!session) return false
  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }
  delete codeIndex[session.code]
  delete pairings[key]
  writeStore({ pairings, codeIndex })
  return true
}

export function getCodeForChat(
  chatId: number,
  threadId: number | undefined,
): string | null {
  const store = readStore()
  const session = store.pairings[sessionKey(chatId, threadId)]
  return session?.code ?? null
}
