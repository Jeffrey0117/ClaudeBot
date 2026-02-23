import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AIBackend } from './types.js'

const SESSION_FILE = join(process.cwd(), '.sessions.json')

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
  return `${backend}:${projectPath}`
}

export function getAISessionId(backend: AIBackend, projectPath: string): string | null {
  const namespaced = sessions.get(makeKey(backend, projectPath))
  if (namespaced) return namespaced
  // Backward compat: check bare path key (old Claude-only format)
  if (backend === 'claude') {
    return sessions.get(projectPath) ?? null
  }
  return null
}

export function setAISessionId(backend: AIBackend, projectPath: string, sessionId: string): void {
  sessions.set(makeKey(backend, projectPath), sessionId)
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
