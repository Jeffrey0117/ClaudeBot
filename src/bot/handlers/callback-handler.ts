import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { getUserState, setUserProject, setUserAI } from '../state.js'
import { addBookmark, removeBookmark, getBookmarks } from '../bookmarks.js'
import { updateBotBio, pinProjectStatus } from '../bio-updater.js'
import { getSuggestion, clearSuggestions } from '../suggestion-store.js'
import { getChoice, clearChoices } from '../choice-store.js'
import { enqueue } from '../../claude/queue.js'
import { getAISessionId } from '../../ai/session-store.js'
import { handleParallelCallback, createParallelJobFromSuggestion } from '../commands/parallel.js'
import { consumeParallelSuggestion } from './message-handler.js'
import { addText } from '../ordered-message-buffer.js'
import { pendingResends } from '../commands/last.js'
import { Markup } from 'telegraf'
import type { AIModelSelection, ProjectInfo } from '../../types/index.js'
import { formatAILabel, resolveBackend } from '../../ai/types.js'
import { getThreadId } from '../../utils/callback-helpers.js'
import { getPairing } from '../../remote/pairing-store.js'

/** Get selected project, or fall back to remote project if paired. */
function getEffectiveProject(chatId: number, threadId: number | undefined): ProjectInfo | null {
  const state = getUserState(chatId, threadId)
  if (state.selectedProject) return state.selectedProject
  const pairing = getPairing(chatId, threadId)
  if (pairing?.connected) return { name: 'remote', path: process.cwd() }
  return null
}

export async function callbackHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return

  const data = ctx.callbackQuery.data
  if (!data) return

  if (data.startsWith('confirm_directive:')) {
    await handleConfirmDirective(ctx, chatId, data)
  } else if (data.startsWith('confirm:')) {
    await handleConfirm(ctx, chatId, data)
  } else if (data.startsWith('choice:')) {
    await handleChoice(ctx, chatId, data)
  } else if (data.startsWith('suggest:')) {
    await handleSuggestion(ctx, chatId, data)
  } else if (data.startsWith('project:')) {
    await handleProjectSelect(ctx, chatId, data.slice('project:'.length))
  } else if (data.startsWith('rproject:')) {
    await handleRemoteProjectSelect(ctx, chatId, data.slice('rproject:'.length))
  } else if (data.startsWith('ai:')) {
    await handleAISelect(ctx, chatId, data.slice('ai:'.length))
  } else if (data.startsWith('model:')) {
    // Backward compat: old model:xxx callbacks → translate to ai:claude:xxx
    await handleAISelect(ctx, chatId, `claude:${data.slice('model:'.length)}`)
  } else if (data.startsWith('parallel_suggest:')) {
    await handleParallelSuggest(ctx, chatId, true)
  } else if (data.startsWith('parallel_suggest_skip:')) {
    await handleParallelSuggest(ctx, chatId, false)
  } else if (data.startsWith('parallel:')) {
    await handleParallelCallback(ctx, chatId, data)
  } else if (data.startsWith('last_resend:')) {
    await handleLastResend(ctx, chatId)
  } else if (data.startsWith('last_cancel:')) {
    pendingResends.delete(chatId)
    await ctx.answerCbQuery('已取消')
    await ctx.editMessageText('❌ 已取消重送')
  } else if (data === 'bookmark:add') {
    await handleBookmarkAdd(ctx, chatId)
  } else if (data.startsWith('bookmark:remove:')) {
    const slot = parseInt(data.slice('bookmark:remove:'.length), 10)
    await handleBookmarkRemove(ctx, chatId, slot)
  } else {
    await ctx.answerCbQuery()
  }
}

async function handleProjectSelect(ctx: BotContext, chatId: number, name: string): Promise<void> {
  const project = findProject(name)
  if (!project) {
    await ctx.answerCbQuery(`\u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${name}"`)
    return
  }

  const threadId = getThreadId(ctx)

  try {
    validateProjectPath(project.path)
  } catch {
    await ctx.answerCbQuery('\u{5C08}\u{6848}\u{8DEF}\u{5F91}\u{5DF2}\u{5931}\u{6548}')
    return
  }

  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)

  await ctx.editMessageText(
    `\u{2705} \u{5DF2}\u{9078}\u{64C7}: *${project.name}*\n\u{6A21}\u{578B}: ${formatAILabel(state.ai)}\n\n\u{50B3}\u{9001}\u{8A0A}\u{606F}\u{958B}\u{59CB}\u{5C0D}\u{8A71}\u{3002}`,
    { parse_mode: 'Markdown' }
  )
  await ctx.answerCbQuery()

  await updateBotBio(project)
  await pinProjectStatus(chatId, project, formatAILabel(state.ai))
}

async function handleRemoteProjectSelect(ctx: BotContext, chatId: number, name: string): Promise<void> {
  const threadId = getThreadId(ctx)

  // Remote project: name is the folder name under agent's base-dir
  // Use name as both project name and path identifier
  const project: ProjectInfo = { name, path: `remote:${name}` }
  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)

  await ctx.editMessageText(
    `\u{2705} \u{5DF2}\u{9078}\u{64C7}: *${name}*\n\u{6A21}\u{578B}: ${formatAILabel(state.ai)}\n\n\u{50B3}\u{9001}\u{8A0A}\u{606F}\u{958B}\u{59CB}\u{5C0D}\u{8A71}\u{3002}`,
    { parse_mode: 'Markdown' },
  )
  await ctx.answerCbQuery()
}

async function handleAISelect(ctx: BotContext, chatId: number, payload: string): Promise<void> {
  // payload format: "auto:auto" or "claude:sonnet" or "gemini:flash"
  const parts = payload.split(':')
  if (parts.length !== 2) {
    await ctx.answerCbQuery('\u{7121}\u{6548}\u{7684}\u{9078}\u{64C7}')
    return
  }
  const [backend, model] = parts
  const ai: AIModelSelection = { backend: backend as AIModelSelection['backend'], model }

  const threadId = getThreadId(ctx)
  setUserAI(chatId, ai, threadId)

  await ctx.editMessageText(`\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{70BA} *${formatAILabel(ai)}*`, { parse_mode: 'Markdown' })
  await ctx.answerCbQuery()

  // Update pin to reflect new model
  const state = getUserState(chatId, threadId)
  if (state.selectedProject) {
    await pinProjectStatus(chatId, state.selectedProject, formatAILabel(ai))
  }
}

async function handleBookmarkAdd(ctx: BotContext, chatId: number): Promise<void> {
  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.answerCbQuery('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}')
    return
  }

  const slot = addBookmark(chatId, state.selectedProject)
  if (slot === null) {
    await ctx.answerCbQuery('\u{5DF2}\u{5B58}\u{5728}\u{6216}\u{5DF2}\u{9054}\u{4E0A}\u{9650} 9 \u{500B}')
    return
  }

  const bookmarks = getBookmarks(chatId)
  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ \u{52A0}\u{5165}\u{76EE}\u{524D}\u{5C08}\u{6848}', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`\u{79FB}\u{9664} /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]
  await ctx.editMessageText(
    `*\u{66F8}\u{7C64}*\n${lines.join('\n')}\n\n\u{2705} \u{5DF2}\u{5C07} ${state.selectedProject.name} \u{52A0}\u{5165}\u{66F8}\u{7C64} /${slot}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
  await ctx.answerCbQuery()
}

async function handleConfirmDirective(ctx: BotContext, chatId: number, data: string): Promise<void> {
  // data = "confirm_directive:0:Option Text"
  const parts = data.split(':')
  const answer = parts.slice(2).join(':') || `選項 ${parts[1]}`

  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = getEffectiveProject(chatId, threadId)

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.answerCbQuery(`已選擇: ${answer}`)

  if (!project) {
    await ctx.telegram.sendMessage(chatId, '⚠️ 尚未選擇專案')
    return
  }

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  enqueue({
    chatId,
    prompt: answer,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleConfirm(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const answer = data === 'confirm:yes' ? '是，請繼續' : '不用了'

  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = getEffectiveProject(chatId, threadId)

  // Remove buttons
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.answerCbQuery(`已回答: ${answer}`)

  if (!project) {
    await ctx.telegram.sendMessage(chatId, '⚠️ 尚未選擇專案')
    return
  }

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  enqueue({
    chatId,
    prompt: answer,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleChoice(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const index = parseInt(data.slice('choice:'.length), 10)

  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = getEffectiveProject(chatId, threadId)

  if (!project) {
    await ctx.answerCbQuery('\u5C1A\u672A\u9078\u64C7\u5C08\u6848')
    return
  }

  const choice = getChoice(chatId, project.path, index)
  if (!choice) {
    await ctx.answerCbQuery('\u9078\u9805\u5DF2\u904E\u671F')
    return
  }

  // Remove buttons and show selected choice
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.answerCbQuery()

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
  clearChoices(chatId, project.path)

  enqueue({
    chatId,
    prompt: choice,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleSuggestion(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const index = parseInt(data.slice('suggest:'.length), 10)

  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = getEffectiveProject(chatId, threadId)

  if (!project) {
    await ctx.answerCbQuery('尚未選擇專案')
    return
  }

  const suggestion = getSuggestion(chatId, project.path, index)
  if (!suggestion) {
    await ctx.answerCbQuery('建議已過期')
    return
  }

  // Remove buttons
  await ctx.editMessageText(`💡 → ${suggestion}`).catch(() => {})
  await ctx.answerCbQuery()

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
  clearSuggestions(chatId, project.path)

  enqueue({
    chatId,
    prompt: suggestion,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleBookmarkRemove(ctx: BotContext, chatId: number, slot: number): Promise<void> {
  if (isNaN(slot)) {
    await ctx.answerCbQuery('\u{7121}\u{6548}\u{7684}\u{7DE8}\u{865F}')
    return
  }

  const removed = removeBookmark(chatId, slot)
  if (!removed) {
    await ctx.answerCbQuery('\u{8A72}\u{66F8}\u{7C64}\u{4E0D}\u{5B58}\u{5728}')
    return
  }

  const bookmarks = getBookmarks(chatId)
  if (bookmarks.length === 0) {
    await ctx.editMessageText('*\u{66F8}\u{7C64}*\n\u{6C92}\u{6709}\u{66F8}\u{7C64}\u{3002}\u{7528} `/fav add` \u{52A0}\u{5165}\u{3002}', { parse_mode: 'Markdown' })
    await ctx.answerCbQuery()
    return
  }

  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ \u{52A0}\u{5165}\u{76EE}\u{524D}\u{5C08}\u{6848}', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`\u{79FB}\u{9664} /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]
  await ctx.editMessageText(
    `*\u{66F8}\u{7C64}*\n${lines.join('\n')}\n\n\u{2705} \u{5DF2}\u{79FB}\u{9664}\u{66F8}\u{7C64} ${slot}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
  await ctx.answerCbQuery()
}

async function handleLastResend(ctx: BotContext, chatId: number): Promise<void> {
  const text = pendingResends.get(chatId)
  pendingResends.delete(chatId)

  if (!text) {
    await ctx.answerCbQuery('已過期')
    await ctx.editMessageText('❌ 訊息已過期，請重新使用 /last')
    return
  }

  await ctx.answerCbQuery('重新發送！')
  await ctx.editMessageText('🔄 重新發送中...')

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  // Feed into the normal message buffer as if user typed it
  addText(chatId, Date.now(), threadId, text, '')
}

async function handleParallelSuggest(ctx: BotContext, chatId: number, useParallel: boolean): Promise<void> {
  const suggestion = consumeParallelSuggestion(chatId)

  // Remove buttons
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})

  if (!suggestion) {
    await ctx.answerCbQuery('建議已過期')
    return
  }

  if (useParallel) {
    await ctx.answerCbQuery('切換到平行模式！')
    await ctx.editMessageText('⚡ 已轉為平行模式')
    // Directly create job and show confirm buttons
    await createParallelJobFromSuggestion(ctx, chatId, suggestion.tasks, suggestion.threadId)
  } else {
    await ctx.answerCbQuery('照常發送')
    await ctx.editMessageText('➡️ 照常發送到 Claude')
    // Send original text through the normal buffer
    addText(chatId, suggestion.messageId, suggestion.threadId, suggestion.originalText, '')
  }
}

