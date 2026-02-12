const sessions = new Map<string, string>()

export function getSessionId(projectPath: string): string | null {
  return sessions.get(projectPath) ?? null
}

export function setSessionId(projectPath: string, sessionId: string): void {
  sessions.set(projectPath, sessionId)
}

export function clearSession(projectPath: string): boolean {
  return sessions.delete(projectPath)
}

export function clearAllSessions(): void {
  sessions.clear()
}
