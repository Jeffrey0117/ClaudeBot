import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'

interface RateLimitEntry {
  readonly timestamps: number[]
}

const limits = new Map<number, RateLimitEntry>()

export function rateLimitMiddleware() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const chatId = ctx.chat?.id
    if (!chatId) return next()

    const now = Date.now()
    const windowStart = now - env.RATE_LIMIT_WINDOW_MS

    let entry = limits.get(chatId)
    if (!entry) {
      entry = { timestamps: [] }
      limits.set(chatId, entry)
    }

    // Remove expired timestamps (mutating for perf in rate limiter only)
    const filtered = entry.timestamps.filter((t) => t > windowStart)
    entry.timestamps.length = 0
    entry.timestamps.push(...filtered)

    if (entry.timestamps.length >= env.RATE_LIMIT_MAX) {
      await ctx.reply('⏳ Rate limited. Please wait a moment.')
      return
    }

    entry.timestamps.push(now)
    return next()
  }
}
