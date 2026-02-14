import type { BotContext } from '../../types/context.js'
import { autoAuth, isAuthenticated, isChatAllowed } from '../../auth/auth-service.js'
import { env } from '../../config/env.js'

const PUBLIC_COMMANDS = new Set(['/start', '/login', '/help'])

export function authMiddleware() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const chatId = ctx.chat?.id
    if (!chatId) return

    if (!isChatAllowed(chatId)) {
      await ctx.reply('\u{26D4} \u{672A}\u{6388}\u{6B0A}\u{7684}\u{804A}\u{5929}\u{3002}')
      return
    }

    if (env.AUTO_AUTH && !isAuthenticated(chatId)) {
      autoAuth(chatId)
    }

    const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
    const command = text?.split(' ')[0] ?? ''

    if (PUBLIC_COMMANDS.has(command)) {
      return next()
    }

    if (ctx.callbackQuery) {
      if (isAuthenticated(chatId)) {
        return next()
      }
      await ctx.answerCbQuery('\u{8ACB}\u{5148} /login \u{767B}\u{5165}\u{3002}')
      return
    }

    if (!isAuthenticated(chatId)) {
      await ctx.reply('\u{1F512} \u{8ACB}\u{5148} /login \u{767B}\u{5165}\u{3002}')
      return
    }

    return next()
  }
}
