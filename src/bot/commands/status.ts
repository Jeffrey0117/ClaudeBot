import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isProcessing, getQueueLength } from '../../claude/queue.js'
import { getSessionId } from '../../claude/session-store.js'

export async function statusCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  const project = state.selectedProject
  const projectName = project ? project.name : '(none)'
  const sessionId = project ? getSessionId(project.path) : null
  const hasSession = sessionId ? 'yes' : 'no'
  const processing = isProcessing() ? '🔄 Running' : '💤 Idle'
  const queueLen = getQueueLength()

  await ctx.reply(
    `📊 *Status*\n\n` +
      `Project: ${projectName}\n` +
      `Model: ${state.model}\n` +
      `Session: ${hasSession}\n` +
      `Claude: ${processing}\n` +
      `Queue: ${queueLen} pending`,
    { parse_mode: 'Markdown' }
  )
}
