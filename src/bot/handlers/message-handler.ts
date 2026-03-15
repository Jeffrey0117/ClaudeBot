import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'
import { getUserState, setUserProject } from '../state.js'
import { recordUserMessage } from '../last-message-store.js'
import { resolveBackend, formatAILabel } from '../../ai/types.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue, isProcessing } from '../../claude/queue.js'
import { cancelAnyRunning } from '../../ai/registry.js'
import { transcribeVoiceFile } from './voice-handler.js'
import { extractReplyQuote } from './reply-quote.js'
import { scanProjects, resolveWorktreePath } from '../../config/projects.js'
import { updateBotBio, pinProjectStatus } from '../bio-updater.js'
import { recordActivity } from '../../plugins/stats/activity-logger.js'
import { addText, clearBuffer } from '../ordered-message-buffer.js'
import { getPairing } from '../../remote/pairing-store.js'
import { getPluginModule } from '../../plugins/loader.js'
import { detectParallelCandidate } from '../../utils/parallel-detector.js'
import { getActiveJob } from '../parallel-store.js'
import { isGitRepo } from '../../git/worktree.js'
import { Markup } from 'telegraf'
import type { ProjectInfo } from '../../types/index.js'

/** Temporary store for parallel suggestions awaiting user decision. */
export interface ParallelSuggestionEntry {
  readonly tasks: readonly string[]
  readonly originalText: string
  readonly messageId: number
  readonly threadId: number | undefined
  readonly expiresAt: number
}

const parallelSuggestions = new Map<number, ParallelSuggestionEntry>()

/** Get and consume a stored parallel suggestion. */
export function consumeParallelSuggestion(chatId: number): ParallelSuggestionEntry | null {
  const entry = parallelSuggestions.get(chatId)
  if (!entry) return null
  parallelSuggestions.delete(chatId)
  if (Date.now() > entry.expiresAt) return null
  return entry
}

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

// extractReplyQuote moved to reply-quote.ts to avoid circular imports

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
      return resolveWorktreePath(project)
    }
  }

  return null
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
    // Normalize: strip zero-width chars, replace fullwidth slash, trim
    const cleaned = text
      .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/^\uFF0F/, '/')
      .trim()

    // If cleaned text differs and is a valid command, re-dispatch via bot
    if (cleaned !== text && cleaned.startsWith('/')) {
      const cmdName = cleaned.slice(1).split(/[@\s]/)[0]
      if (cmdName) {
        // Try plugin dispatch first
        const { isPluginCommand, dispatchPluginCommand } = await import('../../plugins/loader.js')
        if (isPluginCommand(cmdName)) {
          await dispatchPluginCommand(cmdName, ctx)
          return
        }
        // Try core command dispatch
        const { getCoreCommandHandler } = await import('../bot.js')
        const handler = getCoreCommandHandler(cmdName)
        if (handler) {
          await handler(ctx)
          return
        }
      }
    }

    const cmd = text.split(/\s/)[0]
    await ctx.reply(`❌ 未知指令 ${cmd}。用 /help 查看所有指令。`)
    return
  }

  // Record for /last re-send
  recordUserMessage(chatId, text)

  const messageId = ctx.message?.message_id ?? 0
  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  // @chat one-shot: general chat without selecting a project — bypass buffer
  const chatMatch = text.match(/^@chat[\s(](.+?)[\s)]*$/s) ?? text.match(/^@chat\s+(.+)$/s)
  if (chatMatch) {
    const chatPrompt = chatMatch[1].replace(/^\(|\)$/g, '').trim()
    if (chatPrompt) {
      // Use remote project if paired, otherwise general
      const chatPairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
      const chatProject = chatPairing?.connected
        ? { name: 'remote', path: process.cwd() }
        : { name: 'general', path: process.cwd() }
      const sessionId = getAISessionId(resolveBackend(state.ai.backend), chatProject.path)
      enqueue({
        chatId,
        prompt: replyQuote + chatPrompt,
        project: chatProject,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })
      return
    }
  }

  // Remote pairing active — takes priority over local project selection
  const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
  if (pairing?.connected) {
    // Allot gate: check quota before enqueue (plugin may not be loaded)
    const allotMod = getPluginModule('allot') as Record<string, unknown> | undefined
    if (allotMod?.tryReserve) {
      const check = (allotMod.tryReserve as (c: number, t: number | undefined) => { allowed: boolean; reason?: string; warningLevel?: number })(chatId, threadId)
      if (!check.allowed) {
        await ctx.reply(check.reason ?? '\u{23F3} \u{984D}\u{5EA6}\u{5DF2}\u{7528}\u{5B8C}')
        return
      }
      if (check.warningLevel) {
        const warnMsg = check.warningLevel >= 95
          ? '\u{1F534} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{5373}\u{5C07}\u{7528}\u{5B8C} (95%)'
          : check.warningLevel >= 85
            ? '\u{1F7E1} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{4F7F}\u{7528}\u{5DF2}\u{9054} 85%'
            : '\u{1F4CA} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{4F7F}\u{7528}\u{5DF2}\u{9054} 70%'
        ctx.reply(warnMsg).catch(() => {})
      }
    }

    const remoteProject = { name: 'remote', path: process.cwd() }

    // Steer mode: "!" prefix cancels current remote process and replaces
    if (text.startsWith('!') && isProcessing(remoteProject.path)) {
      const steerText = text.slice(1).trim()
      if (!steerText) {
        await ctx.reply('用法: !<訊息> 取消目前並傳送新提示')
        return
      }
      clearBuffer(chatId, threadId)
      cancelAnyRunning(remoteProject.path)
      const sessionId = getAISessionId(resolveBackend(state.ai.backend), remoteProject.path)
      enqueue({
        chatId,
        threadId,
        prompt: replyQuote + steerText,
        project: remoteProject,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })
      await ctx.reply('🔄 [remote] 已轉向 — 取消目前，處理新提示')
      return
    }

    const sessionId = getAISessionId(resolveBackend(state.ai.backend), remoteProject.path)
    enqueue({
      chatId,
      threadId,
      prompt: replyQuote + text,
      project: remoteProject,
      ai: state.ai,
      sessionId,
      imagePaths: [],
    })
    return
  }

  // No project selected — bypass buffer, show help
  if (!state.selectedProject) {
    await ctx.reply(
      '*ClaudeBot* — Claude Code 遙端控制\n\n'
      + '📂 /projects — 選擇專案來操作程式碼\n'
      + '💬 /chat — 通用對話模式\n'
      + '⚡ `@chat 你的問題` — 快速提問\n'
      + '❓ /help — 查看所有指令',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const project = state.selectedProject

  // Steer mode: message starts with "!" to cancel current and replace
  if (text.startsWith('!') && isProcessing(project.path)) {
    const steerText = text.slice(1).trim()
    if (!steerText) {
      await ctx.reply('用法: !<訊息> 取消目前並傳送新提示')
      return
    }
    clearBuffer(chatId, threadId)
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
    await ctx.reply(`🔄 [${project.name}] 已轉向 — 取消目前，處理新提示`)
    return
  }

  // Auto-switch: if in general mode and user mentions a project name,
  // flush existing buffer and switch to that project
  if (project.name === 'general') {
    const detected = detectProjectMention(text)
    if (detected) {
      setUserProject(chatId, detected, threadId)
      updateBotBio(detected).catch(() => {})
      pinProjectStatus(chatId, detected, formatAILabel(state.ai)).catch(() => {})

      recordActivity({
        timestamp: Date.now(),
        type: 'message_sent',
        project: detected.name,
        promptLength: (replyQuote + text).length,
      })

      const sessionId = getAISessionId(resolveBackend(state.ai.backend), detected.path)
      enqueue({
        chatId,
        prompt: replyQuote + text,
        project: detected,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })
      return
    }
  }

  // Smart parallel detection: suggest /parallel for multi-task messages
  if (!getActiveJob(chatId) && isGitRepo(project.path)) {
    const suggestion = detectParallelCandidate(text)
    if (suggestion && suggestion.tasks.length >= 2) {
      const taskList = suggestion.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')

      await ctx.reply(
        `⚡ 偵測到 ${suggestion.tasks.length} 個獨立任務，建議使用平行模式：\n\n${taskList}`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ 用平行模式', `parallel_suggest:${chatId}`),
            Markup.button.callback('➡️ 照常發送', `parallel_suggest_skip:${chatId}`),
          ],
        ]),
      )

      // Store suggestion for callback
      parallelSuggestions.set(chatId, {
        tasks: suggestion.tasks,
        originalText: replyQuote + text,
        messageId,
        threadId,
        expiresAt: Date.now() + 60_000,
      })
      return
    }
  }

  // Normal message → add to ordered buffer
  const status = addText(chatId, messageId, threadId, text, replyQuote)

  if (status?.isProcessing) {
    await ctx.reply(`📥 [${status.projectName}] 已加入佇列 (前方 ${status.queueLength + 1} 個)\n提示: 前綴 ! 可轉向`)
  }
}
