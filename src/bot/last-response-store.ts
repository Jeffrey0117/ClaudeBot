/**
 * In-memory store for the last AI response per project.
 * Used to inject context when user sends a short reply like "好" or "做吧",
 * so Claude knows what was being discussed.
 */

const lastResponses = new Map<string, string>()

const MAX_STORE_LENGTH = 1500

export function setLastResponse(projectPath: string, text: string): void {
  lastResponses.set(projectPath, text.slice(-MAX_STORE_LENGTH))
}

export function getLastResponse(projectPath: string): string {
  return lastResponses.get(projectPath) ?? ''
}

export function clearLastResponse(projectPath: string): void {
  lastResponses.delete(projectPath)
}
