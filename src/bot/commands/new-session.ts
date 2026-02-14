import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { clearSession } from '../../claude/session-store.js'

export async function newSessionCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('\u{26A0}\u{FE0F} \u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}\u{8ACB}\u{5148}\u{7528} /projects\u{3002}')
    return
  }

  clearSession(state.selectedProject.path)
  await ctx.reply(
    `\u{1F504} \u{5DF2}\u{6E05}\u{9664} *${state.selectedProject.name}* \u{7684}\u{5C0D}\u{8A71}\u{3002}\n\u{4E0B}\u{6B21}\u{50B3}\u{8A0A}\u{5C07}\u{958B}\u{59CB}\u{65B0}\u{5C0D}\u{8A71}\u{3002}`,
    { parse_mode: 'Markdown' }
  )
}
