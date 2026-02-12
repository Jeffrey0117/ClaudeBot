import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { buildModelKeyboard } from '../../telegram/keyboard-builder.js'

export async function modelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  const keyboard = buildModelKeyboard(state.model)
  await ctx.reply(`🤖 Current model: *${state.model}*\nSelect a model:`, {
    ...keyboard,
    parse_mode: 'Markdown',
  })
}
