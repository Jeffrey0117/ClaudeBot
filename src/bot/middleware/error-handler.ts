import type { BotContext } from '../../types/context.js'

export function errorHandler() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    try {
      await next()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`Bot error [chat ${ctx.chat?.id}]:`, error)
      try {
        await ctx.reply(`❌ Error: ${message}`)
      } catch {
        // cannot reply, ignore
      }
    }
  }
}
