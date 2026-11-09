import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { clearAISession } from '../../ai/session-store.js'
import { channelReset } from '../../ai/channel/channel-runner.js'
import { getPairing, remoteProjectPath } from '../../remote/pairing-store.js'
import { clearTask } from '../task-store.js'

export async function newSessionCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  const pairing = getPairing(chatId, threadId, state.activeMachine)
  const project = state.selectedProject
    ?? (pairing?.connected ? { name: 'remote', path: remoteProjectPath(pairing.label) } : null)

  if (!project) {
    await ctx.reply('⚠️ 尚未選擇專案。請先用 /projects。')
    return
  }

  // The backend actually serving this project is not necessarily
  // state.ai.backend: local projects default to `channel` (ordered-message-buffer
  // overrides the selection), so clearing only the resolved backend left the
  // live warm session untouched — /new reported success and changed nothing.
  // Clear both keys and stop the warm process.
  const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
  clearAISession(resolvedBackend, project.path)
  clearAISession('claude', project.path)
  await channelReset(project.path)
  clearTask(project.path)

  await ctx.reply(
    `🔄 已清除 *${project.name}* 的對話。\n下次傳訊將開始新對話。`,
    { parse_mode: 'Markdown' }
  )
}
