/**
 * When this bot process last did anything for a user: an incoming update, or
 * work still queued/running. Reported in the heartbeat so the launcher can put
 * a bot nobody is using to sleep. Starts at process start, so a bot that was
 * just woken stays up for a full idle period.
 */

let lastActivityAt = Date.now()

export function touchActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}
