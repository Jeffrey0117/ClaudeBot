import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    console.error('[session-store] failed to save:', err)
  }
}

const sessions = loadSessions()

export function getSessionId(projectPath: string): string | null {
  return sessions.get(projectPath) ?? null
}

export function setSessionId(projectPath: string, sessionId: string): void {
  sessions.set(projectPath, sessionId)
  saveSessions()
}

export function clearSession(projectPath: string): boolean {
  const deleted = sessions.delete(projectPath)
  if (deleted) saveSessions()
  return deleted
}

export function clearAllSessions(): void {
  sessions.clear()
  saveSessions()
}
