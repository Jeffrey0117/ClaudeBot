import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { clearSession } from '../../claude/session-store.js'

export async function newSessionCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('⚠️ No project selected. Use /projects first.')
    return
  }

  clearSession(state.selectedProject.path)
  await ctx.reply(
    `🔄 Session cleared for *${state.selectedProject.name}*.\nNext message will start a fresh conversation.`,
    { parse_mode: 'Markdown' }
  )
}
