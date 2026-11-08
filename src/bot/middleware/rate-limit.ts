import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'

interface RateLimitEntry {
  readonly timestamps: number[]
}

/** Prompts — the expensive thing, each one can spawn a Claude turn. */
const limits = new Map<number, RateLimitEntry>()

/**
 * Button taps get their own, far larger budget.
 *
 * They used to share the prompt budget, so tapping choice / suggestion buttons
 * — which only act on state the bot itself just offered — burned the same
 * 10-per-60s allowance as real prompts and could lock the user out of sending
 * a message. A tap costs the bot almost nothing; it still gets a ceiling so a
 * stuck finger cannot hammer the Telegram API.
 */
const callbackLimits = new Map<number, RateLimitEntry>()
const CALLBACK_BUDGET_MULTIPLIER = 6

// Periodic cleanup: remove entries with no recent activity
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000
  for (const map of [limits, callbackLimits]) {
    for (const [chatId, entry] of map) {
      if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < cutoff) {
        map.delete(chatId)
      }
    }
  }
}, 60_000)

/** Count this hit and report whether the caller is over budget. */
function overBudget(
  map: Map<number, RateLimitEntry>,
  chatId: number,
  max: number,
  now: number,
): boolean {
  const windowStart = now - env.RATE_LIMIT_WINDOW_MS

  let entry = map.get(chatId)
  if (!entry) {
    entry = { timestamps: [] }
    map.set(chatId, entry)
  }

  // Remove expired timestamps (mutating for perf in rate limiter only)
  const filtered = entry.timestamps.filter((t) => t > windowStart)
  entry.timestamps.length = 0
  entry.timestamps.push(...filtered)

  if (entry.timestamps.length >= max) return true

  entry.timestamps.push(now)
  return false
}

export function rateLimitMiddleware() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const chatId = ctx.chat?.id
    if (!chatId) return next()

    const now = Date.now()

    if (ctx.callbackQuery) {
      const max = env.RATE_LIMIT_MAX * CALLBACK_BUDGET_MULTIPLIER
      if (overBudget(callbackLimits, chatId, max, now)) {
        // Answer the tap instead of posting a message — a rate-limit notice in
        // the chat for a button press is pure noise.
        await ctx.answerCbQuery('⏳ 太快了，稍等一下').catch(() => {})
        return
      }
      return next()
    }

    if (overBudget(limits, chatId, env.RATE_LIMIT_MAX, now)) {
      await ctx.reply('⏳ Rate limited. Please wait a moment.')
      return
    }

    return next()
  }
}
