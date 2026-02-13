import type { BotContext } from '../../types/context.js'
import { autoAuth, isAuthenticated, isChatAllowed } from '../../auth/auth-service.js'
import { env } from '../../config/env.js'

const PUBLIC_COMMANDS = new Set(['/start', '/login', '/help'])

export function authMiddleware() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const chatId = ctx.chat?.id
    if (!chatId) return

    if (!isChatAllowed(chatId)) {
      await ctx.reply('⛔ Unauthorized chat.')
      return
    }

    // Auto-authenticate allowed chats when AUTO_AUTH is enabled
    if (env.AUTO_AUTH && !isAuthenticated(chatId)) {
      autoAuth(chatId)
    }

    const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
    const command = text?.split(' ')[0] ?? ''

    if (PUBLIC_COMMANDS.has(command)) {
      return next()
    }

    // Allow callback queries from authenticated users
    if (ctx.callbackQuery) {
      if (isAuthenticated(chatId)) {
        return next()
      }
      await ctx.answerCbQuery('Please /login first.')
      return
    }

    if (!isAuthenticated(chatId)) {
      await ctx.reply('🔒 Please /login first.')
      return
    }

    return next()
  }
}
