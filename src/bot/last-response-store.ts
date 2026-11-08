/**
 * Last Response Store
 *
 * Stores the last AI response per project for context injection.
 * Used when user sends a short reply like "好" or "做吧",
 * so Claude knows what was being discussed.
 *
 * Two storage layers:
 * 1. In-memory map (truncated tail) — for quick context injection
 * 2. Full response file (data/last-response-full/*.md) — Claude can Read() it
 *
 * Persisted to data/last-responses.json so context survives bot restarts.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { statePath } from '../config/paths.js'

const BOT_ID = env.BOT_TOKEN.slice(-6)
const STORE_FILE = statePath('data', 'last-responses.json')
const FULL_RESPONSE_DIR = statePath('data', 'last-response-full')
const MAX_STORE_LENGTH = 1500

/**
 * How many past responses to keep per project.
 *
 * This used to be exactly one: a single fixed filename, overwritten every turn.
 * So "go back to what you said before that" was unanswerable — the earlier
 * reply was gone from disk and, with the session key bug, from the model's
 * context too. 20 turns of history is a few hundred KB.
 */
const MAX_HISTORY = 20

type PersistedData = Record<string, string>

function loadAll(): PersistedData {
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function loadStore(): Map<string, string> {
  const all = loadAll()
  const prefix = `${BOT_ID}:`
  const map = new Map<string, string>()
  for (const [key, text] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      map.set(key.slice(prefix.length), text)
    }
  }
  return map
}

function persistStore(): void {
  const all = loadAll()
  const prefix = `${BOT_ID}:`
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) delete all[key]
  }
  for (const [key, text] of lastResponses) {
    all[`${prefix}${key}`] = text
  }
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true })
    const tmp = `${STORE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, STORE_FILE)
  } catch (err) {
    console.error('[last-response] failed to persist:', err)
  }
}

const lastResponses = loadStore()

/** Sanitize project path to a safe filename. */
function toFileName(projectPath: string): string {
  return projectPath
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100)
}

/**
 * Short stable hash of the full path.
 *
 * toFileName() truncates to 100 chars, so two projects whose sanitised paths
 * agree in the first 100 characters used to share one file — and one project's
 * "previous response" was served to the other. The hash makes the slot unique.
 */
function pathHash(projectPath: string): string {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 8)
}

/** Directory holding this project's recent responses, newest kept alongside older ones. */
export function getResponseHistoryDir(projectPath: string): string {
  return join(FULL_RESPONSE_DIR, `${BOT_ID}_${toFileName(projectPath)}_${pathHash(projectPath)}`)
}

/** Stored response files for a project, newest first. */
export function listResponseFiles(projectPath: string): readonly string[] {
  const dir = getResponseHistoryDir(projectPath)
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Get the file path for a project's full last response (newest in history). */
export function getLastResponseFilePath(projectPath: string): string {
  return listResponseFiles(projectPath)[0] ?? join(getResponseHistoryDir(projectPath), 'latest.md')
}

export function setLastResponse(projectPath: string, text: string): void {
  // Truncated tail for in-memory quick access
  lastResponses.set(projectPath, text.slice(-MAX_STORE_LENGTH))
  persistStore()

  // Full response to a timestamped file — Claude can Read() or Glob() these
  try {
    const dir = getResponseHistoryDir(projectPath)
    mkdirSync(dir, { recursive: true })
    // ISO timestamps sort lexicographically, which is what listResponseFiles
    // relies on. Two turns can land in the same millisecond, so disambiguate
    // with a counter rather than silently overwriting the earlier one.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let name = `${stamp}.md`
    for (let i = 1; existsSync(join(dir, name)); i++) {
      name = `${stamp}-${String(i).padStart(3, '0')}.md`
    }
    writeFileSync(join(dir, name), text, 'utf-8')

    // Prune to the newest MAX_HISTORY
    const files = listResponseFiles(projectPath)
    for (const stale of files.slice(MAX_HISTORY)) {
      try {
        unlinkSync(stale)
      } catch {
        // best effort
      }
    }
  } catch (err) {
    console.error('[last-response] failed to save full response:', err)
  }
}

export function getLastResponse(projectPath: string): string {
  return lastResponses.get(projectPath) ?? ''
}

export function clearLastResponse(projectPath: string): void {
  lastResponses.delete(projectPath)
  persistStore()
}
