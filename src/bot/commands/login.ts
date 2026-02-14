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
    await ctx.reply('\u{7528}\u{6CD5}: /login <\u{5BC6}\u{78BC}>\n(\u{8A0A}\u{606F}\u{6703}\u{81EA}\u{52D5}\u{522A}\u{9664})')
    return
  }

  const success = await login(chatId, password)

  if (success) {
    await ctx.reply('\u{2705} \u{5DF2}\u{9A57}\u{8B49}\u{FF01}\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}')
  } else {
    await ctx.reply('\u{274C} \u{5BC6}\u{78BC}\u{932F}\u{8AA4}\u{6216}\u{672A}\u{6388}\u{6B0A}\u{7684}\u{804A}\u{5929}\u{3002}')
  }
}
