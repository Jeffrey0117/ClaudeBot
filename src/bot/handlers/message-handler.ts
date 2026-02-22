import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getSessionId } from '../../claude/session-store.js'
import { enqueue, isProcessing, getQueueLength } from '../../claude/queue.js'
import { cancelRunning } from '../../claude/claude-runner.js'

const COLLECT_MS = 1000
const pendingMessages = new Map<number, { texts: string[]; timer: ReturnType<typeof setTimeout> }>()

export async function messageHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  if (!text) return

  // Unmatched commands: show hint instead of silently dropping
  if (text.startsWith('/')) {
    const cmd = text.split(/\s/)[0]
    await ctx.reply(`\u{274C} \u{672A}\u{77E5}\u{6307}\u{4EE4} ${cmd}\u{3002}\u{7528} /help \u{67E5}\u{770B}\u{6240}\u{6709}\u{6307}\u{4EE4}\u{3002}`)
    return
  }

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) {
    await ctx.reply('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}\u{7528} /projects \u{9078}\u{64C7}\u{4E00}\u{500B}\u{3002}')
    return
  }

  const project = state.selectedProject
  const projectProcessing = isProcessing(project.path)

  // Steer mode: message starts with "!" to cancel current and replace
  if (text.startsWith('!') && projectProcessing) {
    const steerText = text.slice(1).trim()
    if (!steerText) {
      await ctx.reply('\u{7528}\u{6CD5}: !<\u{8A0A}\u{606F}> \u{53D6}\u{6D88}\u{76EE}\u{524D}\u{4E26}\u{50B3}\u{9001}\u{65B0}\u{63D0}\u{793A}')
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
    await ctx.reply(`\u{1F504} [${project.name}] \u{5DF2}\u{8F49}\u{5411} \u{2014} \u{53D6}\u{6D88}\u{76EE}\u{524D}\u{FF0C}\u{8655}\u{7406}\u{65B0}\u{63D0}\u{793A}`)
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
    await ctx.reply(`\u{1F4E5} [${project.name}] \u{5DF2}\u{52A0}\u{5165}\u{4F47}\u{5217} (\u{524D}\u{65B9} ${qLen + 1} \u{500B})\n\u{63D0}\u{793A}: \u{524D}\u{7DB4} ! \u{53EF}\u{8F49}\u{5411}`)
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
