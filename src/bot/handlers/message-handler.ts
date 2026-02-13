import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getSessionId } from '../../claude/session-store.js'
import { enqueue, isProcessing, getQueueLength } from '../../claude/queue.js'
import { cancelRunning } from '../../claude/claude-runner.js'

const COLLECT_MS = 2000
const pendingMessages = new Map<number, { texts: string[]; timer: ReturnType<typeof setTimeout> }>()

export async function messageHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  if (!text || text.startsWith('/')) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects to pick one first.')
    return
  }

  const project = state.selectedProject
  const projectProcessing = isProcessing(project.path)

  // Steer mode: message starts with "!" to cancel current and replace
  if (text.startsWith('!') && projectProcessing) {
    const steerText = text.slice(1).trim()
    if (!steerText) {
      await ctx.reply('Usage: !<message> to cancel current and send new prompt')
      return
    }
    cancelRunning(project.path)
    const sessionId = getSessionId(project.path)
    enqueue({
      chatId,
      prompt: steerText,
      project,
      model: state.model,
      sessionId,
      imagePaths: [],
    })
    await ctx.reply(`🔄 [${project.name}] Steered — cancelled current, processing new prompt`)
    return
  }

  // Collect mode: batch rapid messages
  let pending = pendingMessages.get(chatId)
  if (pending) {
    pending.texts.push(text)
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => flushMessages(chatId, threadId), COLLECT_MS)
    return
  }

  pending = {
    texts: [text],
    timer: setTimeout(() => flushMessages(chatId), COLLECT_MS),
  }
  pendingMessages.set(chatId, pending)

  if (projectProcessing) {
    const qLen = getQueueLength(project.path)
    await ctx.reply(`📥 [${project.name}] Queued (${qLen + 1} ahead)\nTip: prefix with ! to steer`)
  }
}

function flushMessages(chatId: number, threadId?: number): void {
  const pending = pendingMessages.get(chatId)
  if (!pending) return
  pendingMessages.delete(chatId)

  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) return

  const project = state.selectedProject
  const sessionId = getSessionId(project.path)
  const combined = pending.texts.join('\n\n')

  enqueue({
    chatId,
    prompt: combined,
    project,
    model: state.model,
    sessionId,
    imagePaths: [],
  })
}
