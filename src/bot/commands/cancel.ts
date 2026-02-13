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
      await ctx.reply(`🛑 Cancelled Claude process for *${project.name}*`, { parse_mode: 'Markdown' })
    } else {
      await ctx.reply('⚠️ Could not cancel the process.')
    }
    return
  }

  if (!project && isRunning()) {
    cancelRunning()
    await ctx.reply('🛑 All Claude processes cancelled.')
    return
  }

  await ctx.reply('💤 No Claude process is currently running.')
}
