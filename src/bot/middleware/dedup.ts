import type { MiddlewareFn } from 'telegraf'
import type { BotContext } from '../../types/context.js'

const EXPIRY_MS = 60_000
const CLEANUP_INTERVAL_MS = 30_000
const recentUpdates = new Map<number, number>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, time] of recentUpdates) {
      if (now - time > EXPIRY_MS) recentUpdates.delete(id)
    }
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref?.() // don't keep the process alive for this timer
}

export function dedupMiddleware(): MiddlewareFn<BotContext> {
  // Sweep expired entries on a background interval instead of scanning the
  // whole Map on every incoming update (the old hot path was O(n) per update).
  startCleanup()
  return (ctx, next) => {
    const updateId = ctx.update.update_id
    if (recentUpdates.has(updateId)) return // O(1) dup check
    recentUpdates.set(updateId, Date.now())
    return next()
  }
}
