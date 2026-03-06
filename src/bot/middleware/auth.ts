import type { BotContext } from '../../types/context.js'
import { autoAuth, isAuthenticated, isChatAllowed, isRemoteOnly } from '../../auth/auth-service.js'
import { env } from '../../config/env.js'

const PUBLIC_COMMANDS = new Set(['/start', '/login', '/help'])

/** Commands remote-only users are allowed to use */
const REMOTE_ALLOWED_COMMANDS = new Set([
  '/start', '/login', '/help', '/status', '/cancel', '/new',
  '/pair', '/unpair', '/model', '/projects', '/select', '/chat',
])

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

    // Remote-only users: block non-whitelisted commands, allow text/voice/photo
    if (isRemoteOnly(chatId)) {
      if (command.startsWith('/') && !REMOTE_ALLOWED_COMMANDS.has(command)) {
        await ctx.reply('\u{1F6AB} \u{9060}\u{7AEF}\u{5E33}\u{865F}\u{7121}\u{6CD5}\u{4F7F}\u{7528}\u{6B64}\u{6307}\u{4EE4}')
        return
      }
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
