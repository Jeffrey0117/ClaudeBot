import type { BotContext } from '../../types/context.js'
import { cancelRunning, isRunning } from '../../claude/claude-runner.js'
import { getUserState } from '../state.js'

export async function cancelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  const project = state.selectedProject

  if (project && isRunning(project.path)) {
    const cancelled = cancelRunning(project.path)
    if (cancelled) {
      await ctx.reply(`\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88} *${project.name}* \u{7684} Claude \u{7A0B}\u{5E8F}`, { parse_mode: 'Markdown' })
    } else {
      await ctx.reply('\u{26A0}\u{FE0F} \u{7121}\u{6CD5}\u{53D6}\u{6D88}\u{7A0B}\u{5E8F}\u{3002}')
    }
    return
  }

  if (!project && isRunning()) {
    cancelRunning()
    await ctx.reply('\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88}\u{6240}\u{6709} Claude \u{7A0B}\u{5E8F}\u{3002}')
    return
  }

  await ctx.reply('\u{1F4A4} \u{76EE}\u{524D}\u{6C92}\u{6709}\u{904B}\u{884C}\u{4E2D}\u{7684} Claude \u{7A0B}\u{5E8F}\u{3002}')
}
