import type { BotContext } from '../../types/context.js'
import { cancelAnyRunning, isAnyRunning } from '../../ai/registry.js'
import { getUserState } from '../state.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'

export async function cancelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  // Remote pairing uses process.cwd() as project path (same as message-handler.ts)
  const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
  const project = pairing?.connected
    ? { name: 'remote', path: process.cwd() }
    : state.selectedProject

  if (project && isAnyRunning(project.path)) {
    const cancelled = cancelAnyRunning(project.path)
    if (cancelled) {
      await ctx.reply(`\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88} *${project.name}* \u{7684}\u{7A0B}\u{5E8F}`, { parse_mode: 'Markdown' })
    } else {
      await ctx.reply('\u{26A0}\u{FE0F} \u{7121}\u{6CD5}\u{53D6}\u{6D88}\u{7A0B}\u{5E8F}\u{3002}')
    }
    return
  }

  if (!project && isAnyRunning()) {
    cancelAnyRunning()
    await ctx.reply('\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88}\u{6240}\u{6709}\u{7A0B}\u{5E8F}\u{3002}')
    return
  }

  await ctx.reply('\u{1F4A4} \u{76EE}\u{524D}\u{6C92}\u{6709}\u{904B}\u{884C}\u{4E2D}\u{7684}\u{7A0B}\u{5E8F}\u{3002}')
}
