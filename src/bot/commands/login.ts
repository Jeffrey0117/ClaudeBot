import type { BotContext } from '../../types/context.js'
import { login } from '../../auth/auth-service.js'

export async function loginCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const parts = text?.split(' ') ?? []
  const password = parts.slice(1).join(' ')

  // Delete the message containing the password
  try {
    if (ctx.message) {
      await ctx.deleteMessage(ctx.message.message_id)
    }
  } catch {
    // may not have delete permission
  }

  if (!password) {
    await ctx.reply('Usage: /login <password>\n(Message will be auto-deleted)')
    return
  }

  const success = await login(chatId, password)

  if (success) {
    await ctx.reply('✅ Authenticated! Use /projects to select a project.')
  } else {
    await ctx.reply('❌ Invalid password or unauthorized chat.')
  }
}
