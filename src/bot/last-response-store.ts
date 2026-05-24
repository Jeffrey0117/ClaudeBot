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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { env } from '../config/env.js'

const BOT_ID = env.BOT_TOKEN.slice(-6)
const STORE_FILE = join(process.cwd(), 'data', 'last-responses.json')
const FULL_RESPONSE_DIR = join(process.cwd(), 'data', 'last-response-full')
const MAX_STORE_LENGTH = 1500

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

/** Get the file path for a project's full last response. */
export function getLastResponseFilePath(projectPath: string): string {
  return join(FULL_RESPONSE_DIR, `${BOT_ID}_${toFileName(projectPath)}.md`)
}

export function setLastResponse(projectPath: string, text: string): void {
  // Truncated tail for in-memory quick access
  lastResponses.set(projectPath, text.slice(-MAX_STORE_LENGTH))
  persistStore()

  // Full response to file — Claude can Read() this
  try {
    mkdirSync(FULL_RESPONSE_DIR, { recursive: true })
    const filePath = getLastResponseFilePath(projectPath)
    writeFileSync(filePath, text, 'utf-8')
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
