import type { BotContext } from '../../types/context.js'
import { logout } from '../../auth/auth-service.js'

export async function logoutCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  logout(chatId)
  await ctx.reply('\u{1F44B} \u{5DF2}\u{767B}\u{51FA}\u{3002}\u{7528} /login \u{91CD}\u{65B0}\u{767B}\u{5165}\u{3002}')
}
