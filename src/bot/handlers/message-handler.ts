import type { BotContext } from '../../types/context.js'
import { getUserState, setUserProject } from '../state.js'
import { resolveBackend, formatAILabel } from '../../ai/types.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue, isProcessing, getQueueLength } from '../../claude/queue.js'
import { cancelAnyRunning } from '../../ai/registry.js'
import { transcribeVoiceFile } from './voice-handler.js'
import { scanProjects } from '../../config/projects.js'
import { updateBotBio, pinProjectStatus } from '../bio-updater.js'
import { recordActivity } from '../../plugins/stats/activity-logger.js'
import type { ProjectInfo } from '../../types/index.js'

const COLLECT_MS = 1000
const pendingMessages = new Map<number, { texts: string[]; replyQuote: string; timer: ReturnType<typeof setTimeout> }>()

function extractMentionText(ctx: BotContext, rawText: string): string | null {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
  if (!isGroup) return rawText

  // In group: only respond if @mentioned
  const botUsername = (ctx as unknown as { botInfo?: { username?: string } }).botInfo?.username
  if (!botUsername) return null

  const msg = ctx.message
  if (!msg || !('entities' in msg) || !msg.entities) return null

  const mentionEntity = msg.entities.find(
    (e) => e.type === 'mention' &&
      rawText.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
  )

  if (!mentionEntity) return null

  // Remove the @mention from the text
  const before = rawText.substring(0, mentionEntity.offset)
  const after = rawText.substring(mentionEntity.offset + mentionEntity.length)
  return (before + after).trim()
}

async function extractReplyQuote(ctx: BotContext): Promise<string> {
  const reply = ctx.message && 'reply_to_message' in ctx.message
    ? ctx.message.reply_to_message
    : undefined
  if (!reply) return ''

  // Text or caption
  const replyText = reply && 'text' in reply ? reply.text : ''
  const caption = reply && 'caption' in reply ? reply.caption : ''
  const textContent = replyText || caption || ''

  if (textContent) {
    return `> [引用訊息]\n> ${textContent.split('\n').join('\n> ')}\n\n`
  }

  // Voice message — transcribe it
  if ('voice' in reply && reply.voice) {
    const transcribed = await transcribeVoiceFile(reply.voice.file_id, ctx.telegram)
    if (transcribed) {
      return `> [引用語音]\n> ${transcribed.split('\n').join('\n> ')}\n\n`
    }
  }

  return ''
}

export async function messageHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const rawText = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  if (!rawText) return

  // In groups, only respond to @mentions; strip the mention from text
  const text = extractMentionText(ctx, rawText)
  if (text === null || !text) return

  // Prepend quoted reply content if user replied to a message (supports voice transcription)
  const replyQuote = await extractReplyQuote(ctx)

  // Unmatched commands: show hint instead of silently dropping
  if (text.startsWith('/')) {
    const cmd = text.split(/\s/)[0]
    await ctx.reply(`\u{274C} \u{672A}\u{77E5}\u{6307}\u{4EE4} ${cmd}\u{3002}\u{7528} /help \u{67E5}\u{770B}\u{6240}\u{6709}\u{6307}\u{4EE4}\u{3002}`)
    return
  }

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  // @chat one-shot: general chat without selecting a project
  const chatMatch = text.match(/^@chat[\s(](.+?)[\s)]*$/s) ?? text.match(/^@chat\s+(.+)$/s)
  if (chatMatch) {
    const chatPrompt = chatMatch[1].replace(/^\(|\)$/g, '').trim()
    if (chatPrompt) {
      const generalProject = { name: 'general', path: process.cwd() }
      const sessionId = getAISessionId(resolveBackend(state.ai.backend), generalProject.path)
      enqueue({
        chatId,
        prompt: replyQuote + chatPrompt,
        project: generalProject,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })
      return
    }
  }

  if (!state.selectedProject) {
    await ctx.reply(
      '*ClaudeBot* \u{2014} Claude Code \u{9059}\u{7AEF}\u{63A7}\u{5236}\n\n'
      + '\u{1F4C2} /projects \u{2014} \u{9078}\u{64C7}\u{5C08}\u{6848}\u{4F86}\u{64CD}\u{4F5C}\u{7A0B}\u{5F0F}\u{78BC}\n'
      + '\u{1F4AC} /chat \u{2014} \u{901A}\u{7528}\u{5C0D}\u{8A71}\u{6A21}\u{5F0F}\n'
      + '\u{26A1} `@chat \u{4F60}\u{7684}\u{554F}\u{984C}` \u{2014} \u{5FEB}\u{901F}\u{63D0}\u{554F}\n'
      + '\u{2753} /help \u{2014} \u{67E5}\u{770B}\u{6240}\u{6709}\u{6307}\u{4EE4}',
      { parse_mode: 'Markdown' }
    )
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
    cancelAnyRunning(project.path)
    const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
    enqueue({
      chatId,
      prompt: replyQuote + steerText,
      project,
      ai: state.ai,
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
    replyQuote,
    timer: setTimeout(() => flushMessages(chatId, threadId), COLLECT_MS),
  }
  pendingMessages.set(chatId, pending)

  if (projectProcessing) {
    const qLen = getQueueLength(project.path)
    await ctx.reply(`\u{1F4E5} [${project.name}] \u{5DF2}\u{52A0}\u{5165}\u{4F47}\u{5217} (\u{524D}\u{65B9} ${qLen + 1} \u{500B})\n\u{63D0}\u{793A}: \u{524D}\u{7DB4} ! \u{53EF}\u{8F49}\u{5411}`)
  }
}

/**
 * Detect if user's message mentions a known project name.
 * Returns the first mentioned project, or null.
 */
function detectProjectMention(text: string): ProjectInfo | null {
  const projects = scanProjects()
  const lower = text.toLowerCase()

  // Sort by name length descending to match longer names first
  // (e.g. "ClaudeBot" before "claude")
  const sorted = [...projects].sort((a, b) => b.name.length - a.name.length)

  for (const project of sorted) {
    if (lower.includes(project.name.toLowerCase())) {
      return project
    }
  }

  return null
}

function flushMessages(chatId: number, threadId?: number): void {
  const pending = pendingMessages.get(chatId)
  if (!pending) return
  pendingMessages.delete(chatId)

  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) return

  const combined = pending.replyQuote + pending.texts.join('\n\n')
  const isGeneralMode = state.selectedProject.name === 'general'

  // Auto-switch: if in chat/general mode and user mentions a project name,
  // switch to that project so Claude can actually work on the code
  if (isGeneralMode) {
    const detected = detectProjectMention(combined)
    if (detected) {
      setUserProject(chatId, detected, threadId)
      updateBotBio(detected).catch(() => {})
      pinProjectStatus(chatId, detected, formatAILabel(state.ai)).catch(() => {})

      recordActivity({
        timestamp: Date.now(),
        type: 'message_sent',
        project: detected.name,
        promptLength: combined.length,
      })

      const sessionId = getAISessionId(resolveBackend(state.ai.backend), detected.path)
      enqueue({
        chatId,
        prompt: combined,
        project: detected,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })
      return
    }
  }

  const project = state.selectedProject
  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  recordActivity({
    timestamp: Date.now(),
    type: 'message_sent',
    project: project.name,
    promptLength: combined.length,
  })

  enqueue({
    chatId,
    prompt: combined,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}
