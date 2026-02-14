import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { buildModelKeyboard } from '../../telegram/keyboard-builder.js'

export async function modelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  const keyboard = buildModelKeyboard(state.model)
  await ctx.reply(`\u{1F916} \u{76EE}\u{524D}\u{6A21}\u{578B}: *${state.model}*\n\u{9078}\u{64C7}\u{6A21}\u{578B}:`, {
    ...keyboard,
    parse_mode: 'Markdown',
  })
}
