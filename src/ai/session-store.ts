import { readFileSync, writeFileSync } from 'node:fs'
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

function saveSessions(): void {
  try {
    const obj = Object.fromEntries(sessions)
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2))
  } catch (err) {
    console.error('[ai-session-store] failed to save:', err)
  }
}

const sessions = loadSessions()

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
  // Backward compat: check bare path key (old Claude-only format)
  if (backend === 'claude') {
    const bare = sessions.get(projectPath) ?? null
    if (bare) lastActivity.set(key, Date.now())
    return bare
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
  // Also clear bare path key for backward compat
  if (backend === 'claude') {
    sessions.delete(projectPath)
  }
  if (deleted) saveSessions()
  return deleted
}

export function clearAllAISessions(): void {
  sessions.clear()
  saveSessions()
}
