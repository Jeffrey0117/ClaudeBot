/**
 * File-backed pairing state for remote vibe-coding sessions.
 * Uses a JSON file so all bot processes (main, bot2, bot5, etc.)
 * share the same pairing data — relay runs in main but /pair
 * can be called from any bot instance.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'
import { sessionKey } from '../bot/state.js'

/** BOT_ID prefix isolates pairings per bot instance */
const BOT_ID = env.BOT_TOKEN.slice(-6)

const PAIRING_TTL_MS = 5 * 60 * 1000 // 5 minutes
const STORE_PATH = path.resolve('data', 'pairings.json')

type PairingEventFn = (session: PairingSession, label: string, reason?: string) => void
let onConnectFn: PairingEventFn = () => {}
let onDisconnectFn: PairingEventFn = () => {}

/** Set callback when a remote agent connects. */
export function onPairingConnect(fn: PairingEventFn): void {
  onConnectFn = fn
}

/** Set callback when a remote agent disconnects. */
export function onPairingDisconnect(fn: PairingEventFn): void {
  onDisconnectFn = fn
}

export interface PairingSession {
  readonly code: string
  readonly chatId: number
  readonly threadId: number | undefined
  readonly createdAt: number
  readonly label: string
  readonly connected: boolean
}

/** Build a bot-scoped pairing key so each bot instance has its own pairings. */
function pairingKey(chatId: number, threadId: number | undefined): string {
  return `${BOT_ID}:${sessionKey(chatId, threadId)}`
}

interface StoreData {
  /** Key: BOT_ID:sessionKey → PairingSession */
  readonly pairings: Record<string, PairingSession>
  /** Reverse lookup: code → pairingKey */
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
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, STORE_PATH)
}

function isExpired(session: PairingSession): boolean {
  if (session.connected) return false
  return Date.now() - session.createdAt > PAIRING_TTL_MS
}

export function createPairingCode(
  chatId: number,
  threadId: number | undefined,
): string {
  const key = pairingKey(chatId, threadId)
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
  const key = pairingKey(chatId, threadId)
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
  const updated = { ...session, connected: true, label }
  const pairings = { ...store.pairings, [key]: updated }
  writeStore({ pairings, codeIndex: store.codeIndex })
  // Only fire callback if this pairing belongs to the current bot instance
  if (key.startsWith(`${BOT_ID}:`)) {
    onConnectFn(updated, label)
  }
  return true
}

export function markDisconnected(code: string, reason?: string): void {
  const store = readStore()
  const key = store.codeIndex[code]
  if (!key) return
  const session = store.pairings[key]
  if (!session) return
  const pairings = { ...store.pairings, [key]: { ...session, connected: false } }
  writeStore({ pairings, codeIndex: store.codeIndex })
  if (key.startsWith(`${BOT_ID}:`)) {
    onDisconnectFn(session, session.label, reason ?? '連線中斷')
  }
}

export function removePairing(
  chatId: number,
  threadId: number | undefined,
): boolean {
  const key = pairingKey(chatId, threadId)
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
  const session = store.pairings[pairingKey(chatId, threadId)]
  return session?.code ?? null
}

/** Return all pairings that were connected (for restart notifications). */
export function getAllConnectedPairings(): readonly PairingSession[] {
  const store = readStore()
  return Object.values(store.pairings).filter((s) => s.connected)
}

/** Return connected pairings scoped to the current bot instance. */
export function getBotConnectedPairings(): readonly PairingSession[] {
  const store = readStore()
  return Object.entries(store.pairings)
    .filter(([key, s]) => key.startsWith(`${BOT_ID}:`) && s.connected)
    .map(([, s]) => s)
}

/** Reset all connected flags on startup — stale flags from a crashed relay are lies.
 *  Agents will reconnect and markConnected() sets them back to true.
 *  Refresh createdAt so codes don't expire before agents can reconnect. */
export function resetAllConnectedFlags(): number {
  const store = readStore()
  const connectedKeys = Object.entries(store.pairings)
    .filter(([, s]) => s.connected)
    .map(([k]) => k)
  if (connectedKeys.length === 0) return 0
  const pairings = { ...store.pairings }
  const now = Date.now()
  for (const key of connectedKeys) {
    pairings[key] = { ...pairings[key], connected: false, createdAt: now }
  }
  writeStore({ ...store, pairings })
  return connectedKeys.length
}
