import type { BotContext } from '../../types/context.js'
import { logout } from '../../auth/auth-service.js'

export async function logoutCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  logout(chatId)
  await ctx.reply('👋 Logged out. Use /login to authenticate again.')
}
