/**
 * File-backed pairing state for remote vibe-coding sessions.
 * Uses a JSON file so all bot processes (main, bot2, bot5, etc.)
 * share the same pairing data — relay runs in main but /pair
 * can be called from any bot instance.
 *
 * Supports multiple machines per chat — each machine gets its own
 * key suffix: BOT_ID:chatId:threadId:label
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'
import { sessionKey } from '../bot/state.js'

/** BOT_ID prefix isolates pairings per bot instance */
const BOT_ID = env.BOT_TOKEN.slice(-6)

/** Build a machine-specific project path for queue isolation. */
export function remoteProjectPath(label: string): string {
  return `remote:${label || 'remote'}`
}

/** Check if a project path is a remote machine path. */
export function isRemotePath(projectPath: string): boolean {
  return projectPath.startsWith('remote:')
}

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
  /** Raw hostname from agent registration */
  readonly hostname?: string
  /** Bot token that created this pairing — used by relay to send notifications via correct bot */
  readonly botToken: string
}

/** Build the base key prefix for a chat (without label suffix). */
function basePairingKey(chatId: number, threadId: number | undefined): string {
  return `${BOT_ID}:${sessionKey(chatId, threadId)}`
}

/** Build a full pairing key with label suffix. */
function labeledPairingKey(chatId: number, threadId: number | undefined, label: string): string {
  return `${basePairingKey(chatId, threadId)}:${label}`
}

interface StoreData {
  /** Key: BOT_ID:sessionKey:label → PairingSession */
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

/**
 * Check if a key belongs to a given chat's base prefix.
 * Handles both old format (BOT_ID:chatId[:threadId]) and
 * new format (BOT_ID:chatId[:threadId]:label).
 */
function keyBelongsToChat(key: string, baseKey: string): boolean {
  return key === baseKey || key.startsWith(`${baseKey}:`)
}

/**
 * Deduplicate label: if the same label already exists for this chat,
 * append a number suffix.
 */
function deduplicateLabel(existing: readonly PairingSession[], rawLabel: string): string {
  const lowerLabel = rawLabel.toLowerCase()
  const taken = new Set(existing.map((s) => s.label.toLowerCase()))
  if (!taken.has(lowerLabel)) return rawLabel
  for (let i = 2; i <= 99; i++) {
    const candidate = `${rawLabel}-${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${rawLabel}-${Date.now() % 10000}`
}

export function createPairingCode(
  chatId: number,
  threadId: number | undefined,
): string {
  const store = readStore()
  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }

  // Purge expired entries for this chat to prevent accumulation
  const baseKey = basePairingKey(chatId, threadId)
  for (const [key, session] of Object.entries(pairings)) {
    if (keyBelongsToChat(key, baseKey) && isExpired(session)) {
      delete codeIndex[session.code]
      delete pairings[key]
    }
  }

  // Don't remove previous pairings — allow multiple machines
  // Use the code itself as temporary label suffix until agent connects
  const code = randomBytes(5).toString('base64url').slice(0, 8).toUpperCase()
  const tempKey = labeledPairingKey(chatId, threadId, code)

  const session: PairingSession = {
    code,
    chatId,
    threadId,
    createdAt: Date.now(),
    label: '',
    connected: false,
    botToken: env.BOT_TOKEN,
  }

  pairings[tempKey] = session
  codeIndex[code] = tempKey
  writeStore({ pairings, codeIndex })
  return code
}

/** Get all pairings for a chat (purges expired ones). */
export function getPairings(
  chatId: number,
  threadId: number | undefined,
): readonly PairingSession[] {
  const baseKey = basePairingKey(chatId, threadId)
  const store = readStore()
  let dirty = false
  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }
  const results: PairingSession[] = []

  for (const [key, session] of Object.entries(pairings)) {
    if (!keyBelongsToChat(key, baseKey)) continue

    // Migrate old-format keys: if key === baseKey (no label suffix),
    // rename to baseKey:label format
    if (key === baseKey && session.label) {
      const newKey = labeledPairingKey(chatId, threadId, session.label)
      delete pairings[key]
      pairings[newKey] = session
      codeIndex[session.code] = newKey
      dirty = true
    }

    if (isExpired(session)) {
      delete codeIndex[session.code]
      delete pairings[key]
      dirty = true
      continue
    }
    results.push(session)
  }

  if (dirty) writeStore({ pairings, codeIndex })
  return results
}

/**
 * Get the active machine's pairing for a chat.
 * Uses activeMachine from state; falls back to first connected machine.
 */
export function getPairing(
  chatId: number,
  threadId: number | undefined,
  activeMachine?: string,
): PairingSession | null {
  const all = getPairings(chatId, threadId)
  if (all.length === 0) return null

  // If activeMachine is set, find that specific machine
  if (activeMachine) {
    const active = all.find((s) => s.label === activeMachine && s.connected)
    if (active) return active
  }

  // Fallback: first connected machine
  const connected = all.find((s) => s.connected)
  return connected ?? null
}

/** Get a specific machine's pairing by label. */
export function getPairingByLabel(
  chatId: number,
  threadId: number | undefined,
  label: string,
): PairingSession | null {
  const all = getPairings(chatId, threadId)
  return all.find((s) => s.label === label) ?? null
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

/** Mark a pairing code as connected and rename key to hostname label. */
export function markConnected(code: string, label: string): boolean {
  const store = readStore()
  const oldKey = store.codeIndex[code]
  if (!oldKey) return false
  const session = store.pairings[oldKey]
  if (!session) return false

  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }

  // Deduplicate label among this chat's existing pairings
  const baseKey = basePairingKey(session.chatId, session.threadId)
  const siblings = Object.entries(pairings)
    .filter(([k, s]) => keyBelongsToChat(k, baseKey) && s.code !== code)
    .map(([, s]) => s)
  const finalLabel = deduplicateLabel(siblings, label)

  const newKey = labeledPairingKey(session.chatId, session.threadId, finalLabel)

  // Remove old key, set new key
  delete pairings[oldKey]
  const updated: PairingSession = { ...session, connected: true, label: finalLabel, hostname: label }
  pairings[newKey] = updated
  codeIndex[code] = newKey

  writeStore({ pairings, codeIndex })
  onConnectFn(updated, finalLabel)
  sendPairingNotification(updated, finalLabel)
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
  onDisconnectFn(session, session.label, reason ?? '連線中斷')
  sendDisconnectNotification(session, reason ?? '連線中斷')
}

/** Send connect/disconnect notifications using the pairing's stored botToken. */
function sendPairingNotification(session: PairingSession, label: string): void {
  const token = session.botToken
  if (!token) {
    console.error(`[pair-notify] no botToken for chatId=${session.chatId}, skipping notification`)
    return
  }
  const botId = token.split(':')[0]
  console.error(`[pair-notify] CONNECT chatId=${session.chatId} botId=${botId} label=${label}`)
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: session.chatId,
      text: `🔗 *${label} 已連線*\n_用 /machines 查看所有已配對機器_`,
      parse_mode: 'Markdown',
    }),
    signal: AbortSignal.timeout(5_000),
  }).then((r) => {
    if (!r.ok) console.error(`[pair-notify] Telegram API error: ${r.status}`)
  }).catch((err) => {
    console.error(`[pair-notify] fetch error: ${err instanceof Error ? err.message : err}`)
  })
}

/** Notify the pairing owner about an error reported by their remote agent /
 *  desktop client, so client-side failures aren't invisible on the host. */
export function notifyOwnerError(code: string, message: string): void {
  const session = findByCode(code)
  if (!session?.botToken) return
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  fetch(`${base}/bot${session.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: session.chatId,
      text: `⚠️ ${session.label || 'remote'} 回報錯誤：\n${message.slice(0, 500)}`,
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

function sendDisconnectNotification(session: PairingSession, reason: string): void {
  const token = session.botToken
  if (!token) return
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: session.chatId,
      text: `🔌 ${session.label || 'remote'} 已斷開 — ${reason}`,
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

/**
 * Remove pairings for a chat.
 * If label is provided, remove only that machine.
 * If label is omitted, remove all machines.
 */
export function removePairing(
  chatId: number,
  threadId: number | undefined,
  label?: string,
): boolean {
  const baseKey = basePairingKey(chatId, threadId)
  const store = readStore()
  const pairings = { ...store.pairings }
  const codeIndex = { ...store.codeIndex }
  let removed = false

  if (label) {
    // Remove specific machine
    const targetKey = labeledPairingKey(chatId, threadId, label)
    const session = pairings[targetKey]
    if (session) {
      delete codeIndex[session.code]
      delete pairings[targetKey]
      removed = true
    }
  } else {
    // Remove all pairings for this chat
    for (const [key, session] of Object.entries(pairings)) {
      if (keyBelongsToChat(key, baseKey)) {
        delete codeIndex[session.code]
        delete pairings[key]
        removed = true
      }
    }
  }

  if (removed) writeStore({ pairings, codeIndex })
  return removed
}

export function getCodeForChat(
  chatId: number,
  threadId: number | undefined,
): string | null {
  // Return the first connected machine's code (backward compat)
  const all = getPairings(chatId, threadId)
  const connected = all.find((s) => s.connected)
  return connected?.code ?? all[0]?.code ?? null
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
