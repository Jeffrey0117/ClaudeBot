import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AIBackend } from './types.js'
import { env } from '../config/env.js'

/** Short bot identifier from token (last 6 chars) for session isolation. */
const BOT_ID = env.BOT_TOKEN.slice(-6)
const MY_PREFIX = `${BOT_ID}:`

const SESSION_FILE = join(process.cwd(), '.sessions.json')

/** Sessions auto-expire after 4 hours of inactivity */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000

/** Track last activity time per session key (in-memory only) */
const lastActivity = new Map<string, number>()

/** Track prompt count per session key (in-memory only) */
const promptCounts = new Map<string, number>()

/** Track last-known context-window occupancy (tokens) per session key.
 *  Updated from each turn's result usage; primary rotation signal. */
const sessionTokens = new Map<string, number>()

/** Session keys we've already nudged to use /new (one reminder per session). */
const remindedNew = new Set<string>()

/** Fraction of ROTATE_AT_TOKENS at which we proactively suggest /new
 *  (fires before the auto-rotation so the user has a heads-up). */
const REMIND_TOKEN_FRACTION = 0.6
/** Fallback trigger when token usage is unavailable. */
const REMIND_PROMPT_COUNT = 25

/** Auto-rotate session after this many prompts to prevent context bloat.
 *  Kept as a coarse backstop; the token-occupancy check (ROTATE_AT_TOKENS)
 *  is the primary, accurate signal and usually fires first.
 *  CTX digest provides continuity on rotation. */
const MAX_PROMPTS_PER_SESSION = 50

/** In-memory cache of THIS bot's sessions only */
const mySessions = new Map<string, string>()

// Known AI backends for key format validation
const KNOWN_BACKENDS = new Set(['claude', 'gemini', 'codex', 'channel'])

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

/** Read the full session file from disk (all bots' data). */
function readDiskSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Read-modify-write: merge this bot's in-memory sessions into the disk file.
 * Other bots' keys are preserved untouched.
 */
function persistToDisk(): void {
  try {
    // 1. Read latest from disk (includes other bots' sessions)
    const disk = readDiskSessions()

    // 2. Remove all keys belonging to THIS bot from disk copy
    for (const key of Object.keys(disk)) {
      if (key.startsWith(MY_PREFIX)) {
        delete disk[key]
      }
    }

    // 3. Merge this bot's current in-memory sessions
    for (const [key, sid] of mySessions) {
      disk[key] = sid
    }

    // 4. Atomic write
    const tmp = `${SESSION_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(disk, null, 2))
    renameSync(tmp, SESSION_FILE)
  } catch (err) {
    console.error('[ai-session-store] failed to save:', err)
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveSessions(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistToDisk()
  }, 100)
}

// --- Initialization: load only this bot's sessions from disk ---
{
  const disk = readDiskSessions()
  let migrationNeeded = false

  for (const [key, sid] of Object.entries(disk)) {
    // Skip legacy keys (no backend segment)
    if (!isNewFormatKey(key)) {
      migrationNeeded = true
      continue
    }
    // Only load keys belonging to THIS bot
    if (key.startsWith(MY_PREFIX)) {
      mySessions.set(key, sid)
    }
  }

  // Clean up legacy keys from disk (one-time)
  if (migrationNeeded) {
    const cleaned: Record<string, string> = {}
    for (const [key, sid] of Object.entries(disk)) {
      if (isNewFormatKey(key)) {
        cleaned[key] = sid
      }
    }
    try {
      const tmp = `${SESSION_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(cleaned, null, 2))
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
    const hours = Math.round(SESSION_TTL_MS / 3600000)
    console.log(`[ai-session] auto-expired session for ${projectPath} (idle > ${hours}h)`)
    mySessions.delete(key)
    lastActivity.delete(key)
    sessionTokens.delete(key)
    remindedNew.delete(key)
    saveSessions()
    return null
  }

  const sid = mySessions.get(key)
  if (sid) {
    lastActivity.set(key, Date.now())
    return sid
  }

  // Fallback: re-read disk in case another process wrote for this bot
  // (e.g. after restart, in-memory is empty but disk has the session)
  const disk = readDiskSessions()
  const diskSid = disk[key]
  if (diskSid) {
    mySessions.set(key, diskSid)
    lastActivity.set(key, Date.now())
    return diskSid
  }

  return null
}

export function setAISessionId(backend: AIBackend, projectPath: string, sessionId: string): void {
  const key = makeKey(backend, projectPath)
  mySessions.set(key, sessionId)
  lastActivity.set(key, Date.now())
  promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1)
  saveSessions()
}

export function clearAISession(backend: AIBackend, projectPath: string): boolean {
  const key = makeKey(backend, projectPath)
  const deleted = mySessions.delete(key)
  // Reset occupancy so the fresh session doesn't inherit a stale token count
  // and rotate immediately on its first turn.
  sessionTokens.delete(key)
  remindedNew.delete(key)
  if (deleted) saveSessions()
  return deleted
}

export function clearAllAISessions(): void {
  mySessions.clear()
  promptCounts.clear()
  saveSessions()
}

/** Get the number of prompts processed in the current session. */
export function getSessionPromptCount(backend: AIBackend, projectPath: string): number {
  return promptCounts.get(makeKey(backend, projectPath)) ?? 0
}

/** Record the context-window occupancy (tokens) reported by the latest turn. */
export function setSessionTokens(backend: AIBackend, projectPath: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  sessionTokens.set(makeKey(backend, projectPath), tokens)
}

/** Get the last-known context-window occupancy (tokens) for the session. */
export function getSessionTokens(backend: AIBackend, projectPath: string): number {
  return sessionTokens.get(makeKey(backend, projectPath)) ?? 0
}

/** True once a session has grown long enough that we should remind the user
 *  they can start fresh with /new — at most once per session. */
export function needsNewReminder(backend: AIBackend, projectPath: string): boolean {
  const key = makeKey(backend, projectPath)
  if (remindedNew.has(key)) return false
  if (getSessionTokens(backend, projectPath) >= env.ROTATE_AT_TOKENS * REMIND_TOKEN_FRACTION) return true
  return getSessionPromptCount(backend, projectPath) >= REMIND_PROMPT_COUNT
}

/** Mark that we've shown the /new reminder for this session. */
export function markNewReminded(backend: AIBackend, projectPath: string): void {
  remindedNew.add(makeKey(backend, projectPath))
}

/** Check if session should be rotated. Primary signal: context-window occupancy
 *  crossed ROTATE_AT_TOKENS (rotate before the model's lossy auto-compact fires).
 *  Backstop: prompt count, in case usage data is unavailable. */
export function shouldRotateSession(backend: AIBackend, projectPath: string): boolean {
  if (getSessionTokens(backend, projectPath) >= env.ROTATE_AT_TOKENS) return true
  return getSessionPromptCount(backend, projectPath) >= MAX_PROMPTS_PER_SESSION
}

/** Rotate session: clear session + prompt count so next run starts fresh.
 *  CTX digest injection handles context continuity automatically. */
export function rotateSession(backend: AIBackend, projectPath: string): number {
  const key = makeKey(backend, projectPath)
  const count = promptCounts.get(key) ?? 0
  mySessions.delete(key)
  promptCounts.delete(key)
  sessionTokens.delete(key)
  remindedNew.delete(key)
  lastActivity.delete(key)
  saveSessions()
  return count
}

/** Periodic cleanup: remove orphaned tracking entries for expired/deleted sessions. */
function cleanupOrphanedEntries(): void {
  for (const key of [...lastActivity.keys()]) {
    if (!mySessions.has(key)) {
      lastActivity.delete(key)
      promptCounts.delete(key)
      sessionTokens.delete(key)
      remindedNew.delete(key)
    }
  }
}

const cleanupTimer = setInterval(cleanupOrphanedEntries, 30 * 60 * 1000)
cleanupTimer.unref()
