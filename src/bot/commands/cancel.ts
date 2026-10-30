import type { BotContext } from '../../types/context.js'
import { cancelAnyRunning, isAnyRunning } from '../../ai/registry.js'
import { clearQueue, getQueueLength } from '../../claude/queue.js'
import { getUserState } from '../state.js'
import { getPairing, remoteProjectPath } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'
import { cancelActiveAgent } from '../vision/web-agent-store.js'
import { isChannelEnabled } from '../../ai/channel/opt-in-store.js'
import { channelInterrupt, isChannelRunning } from '../../ai/channel/channel-runner.js'

export async function cancelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Cancel web agent if active
  if (cancelActiveAgent(chatId)) {
    await ctx.reply('\u{1F6D1} 已取消網頁自動化')
    return
  }

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
  const project = pairing?.connected
    ? { name: 'remote', path: remoteProjectPath(pairing.label) }
    : state.selectedProject

  // Channel opt-in: interrupt the current turn but keep the session alive.
  // Return early so the kill-path below is skipped.
  if (project && isChannelEnabled(project.path) && isChannelRunning(project.path)) {
    channelInterrupt(project.path)
    await ctx.reply('🛑 已中斷當前回合（session 還在，直接打下一個任務即可）')
    return
  }

  if (project && isAnyRunning(project.path)) {
    const cancelled = cancelAnyRunning(project.path)
    // Cancel means "stop everything I queued", not just the running turn —
    // otherwise queued prompts fire right after the kill.
    const dropped = clearQueue(project.path).length
    const droppedNote = dropped > 0 ? `（佇列中 ${dropped} 筆一併清除）` : ''
    if (cancelled) {
      await ctx.reply(`\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88} *${project.name}* \u{7684}\u{7A0B}\u{5E8F}${droppedNote}`, { parse_mode: 'Markdown' })
    } else {
      await ctx.reply(`\u{26A0}\u{FE0F} \u{7121}\u{6CD5}\u{53D6}\u{6D88}\u{7A0B}\u{5E8F}\u{3002}${droppedNote}`)
    }
    return
  }

  if (!project && isAnyRunning()) {
    cancelAnyRunning()
    const dropped = clearQueue().length
    await ctx.reply(`\u{1F6D1} \u{5DF2}\u{53D6}\u{6D88}\u{6240}\u{6709}\u{7A0B}\u{5E8F}\u{3002}${dropped > 0 ? `（佇列清除 ${dropped} 筆）` : ''}`)
    return
  }

  // Nothing running, but prompts may still be queued (e.g. waiting on a lock)
  const pendingCount = project ? getQueueLength(project.path) : getQueueLength()
  if (pendingCount > 0) {
    const dropped = project ? clearQueue(project.path).length : clearQueue().length
    await ctx.reply(`\u{1F9F9} 已清除佇列中的 ${dropped} 筆任務。`)
    return
  }

  await ctx.reply('\u{1F4A4} \u{76EE}\u{524D}\u{6C92}\u{6709}\u{904B}\u{884C}\u{4E2D}\u{7684}\u{7A0B}\u{5E8F}\u{3002}')
}
