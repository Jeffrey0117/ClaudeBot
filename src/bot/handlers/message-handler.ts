import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getSessionId } from '../../claude/session-store.js'
import { enqueue } from '../../claude/queue.js'

export async function messageHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  if (!text || text.startsWith('/')) return

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects to pick one first.')
    return
  }

  const project = state.selectedProject
  const sessionId = getSessionId(project.path)

  // Fire and forget — don't block Telegraf's handler
  enqueue({
    chatId,
    prompt: text,
    project,
    model: state.model,
    sessionId,
  })

  await ctx.reply('⏳ Queued...')
}
