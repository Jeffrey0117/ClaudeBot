import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { clearAISession } from '../../ai/session-store.js'
import { getPairing } from '../../remote/pairing-store.js'

export async function newSessionCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
    ?? (getPairing(chatId, threadId)?.connected ? { name: 'remote', path: process.cwd() } : null)

  if (!project) {
    await ctx.reply('⚠️ 尚未選擇專案。請先用 /projects。')
    return
  }

  const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
  clearAISession(resolvedBackend, project.path)
  await ctx.reply(
    `🔄 已清除 *${project.name}* 的對話。\n下次傳訊將開始新對話。`,
    { parse_mode: 'Markdown' }
  )
}
