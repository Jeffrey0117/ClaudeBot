import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AIBackend } from './types.js'
import { env } from '../config/env.js'

/** Short bot identifier from token (last 6 chars) for session isolation. */
const BOT_ID = env.BOT_TOKEN.slice(-6)

const SESSION_FILE = join(process.cwd(), '.sessions.json')

/** Sessions auto-expire after 30 minutes of inactivity */
const SESSION_TTL_MS = 30 * 60 * 1000

/** Track last activity time per session key (in-memory only) */
const lastActivity = new Map<string, number>()

function loadSessions(): Map<string, string> {
  try {
    const data = readFileSync(SESSION_FILE, 'utf-8')
    return new Map(Object.entries(JSON.parse(data)))
  } catch {
    return new Map()
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveSessions(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const tmp = `${SESSION_FILE}.tmp`
      const obj = Object.fromEntries(sessions)
      writeFileSync(tmp, JSON.stringify(obj, null, 2))
      renameSync(tmp, SESSION_FILE)
    } catch (err) {
      console.error('[ai-session-store] failed to save:', err)
    }
  }, 100)
}

const sessions = loadSessions()

// Known AI backends for key format validation
const KNOWN_BACKENDS = new Set(['claude', 'gemini', 'codex'])

/** Check if a key is the valid new format: BOT_ID:backend:path */
function isNewFormatKey(key: string): boolean {
  const firstColon = key.indexOf(':')
  if (firstColon === -1) return false
  const afterBotId = key.substring(firstColon + 1)
  const secondColon = afterBotId.indexOf(':')
  if (secondColon === -1) return false
  const backend = afterBotId.substring(0, secondColon)
  return KNOWN_BACKENDS.has(backend)
}

// One-time migration: remove legacy keys and detect shared session IDs.
// Root cause of cross-bot contamination: all bots inherited the same session ID
// from bare keys, so --resume would load another bot's conversation history.
{
  let migrationNeeded = false
  const myPrefix = `${BOT_ID}:`

  // Phase 1: Remove any key that is NOT the valid new format (BOT_ID:backend:path)
  for (const key of [...sessions.keys()]) {
    if (!isNewFormatKey(key)) {
      sessions.delete(key)
      migrationNeeded = true
    }
  }

  // Phase 2: Detect session IDs shared across different bots and clear ours.
  // If another bot uses the same session ID, we must start a fresh session.
  const sessionIdToOwners = new Map<string, string[]>()
  for (const [key, sid] of sessions) {
    const owners = sessionIdToOwners.get(sid) ?? []
    owners.push(key)
    sessionIdToOwners.set(sid, owners)
  }
  for (const [sid, owners] of sessionIdToOwners) {
    if (owners.length <= 1) continue
    const hasForeignOwner = owners.some((k) => !k.startsWith(myPrefix))
    if (!hasForeignOwner) continue
    for (const key of owners) {
      if (key.startsWith(myPrefix)) {
        console.error(`[ai-session] ${BOT_ID}: clearing contaminated session ${sid.slice(0, 8)}... (shared with other bot)`)
        sessions.delete(key)
        migrationNeeded = true
      }
    }
  }

  // Write synchronously to minimize race window with other bot processes
  if (migrationNeeded) {
    try {
      const tmp = `${SESSION_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions), null, 2))
      renameSync(tmp, SESSION_FILE)
    } catch (err) {
      console.error('[ai-session] migration save failed:', err)
    }
  }
}

function makeKey(backend: AIBackend, projectPath: string): string {
  return `${BOT_ID}:${backend}:${projectPath}`
}

function isExpired(key: string): boolean {
  const last = lastActivity.get(key)
  if (!last) return false // No activity tracked yet → treat as fresh
  return Date.now() - last > SESSION_TTL_MS
}

export function getAISessionId(backend: AIBackend, projectPath: string): string | null {
  const key = makeKey(backend, projectPath)

  // Auto-expire: if idle too long, clear session and start fresh
  if (isExpired(key)) {
    console.log(`[ai-session] auto-expired session for ${projectPath} (idle > 30min)`)
    sessions.delete(key)
    lastActivity.delete(key)
    saveSessions()
    return null
  }

  const namespaced = sessions.get(key)
  if (namespaced) {
    lastActivity.set(key, Date.now())
    return namespaced
  }
  return null
}

export function setAISessionId(backend: AIBackend, projectPath: string, sessionId: string): void {
  const key = makeKey(backend, projectPath)
  sessions.set(key, sessionId)
  lastActivity.set(key, Date.now())
  saveSessions()
}

export function clearAISession(backend: AIBackend, projectPath: string): boolean {
  const key = makeKey(backend, projectPath)
  const deleted = sessions.delete(key)
  if (deleted) saveSessions()
  return deleted
}

export function clearAllAISessions(): void {
  sessions.clear()
  saveSessions()
}
