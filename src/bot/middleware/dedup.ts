import type { MiddlewareFn } from 'telegraf'
import type { BotContext } from '../../types/context.js'

const EXPIRY_MS = 60_000
const recentUpdates = new Map<number, number>()

export function dedupMiddleware(): MiddlewareFn<BotContext> {
  return (ctx, next) => {
    const updateId = ctx.update.update_id
    const now = Date.now()

    // Cleanup expired entries
    for (const [id, time] of recentUpdates) {
      if (now - time > EXPIRY_MS) {
        recentUpdates.delete(id)
      }
    }

    if (recentUpdates.has(updateId)) {
      return
    }

    recentUpdates.set(updateId, now)
    return next()
  }
}
