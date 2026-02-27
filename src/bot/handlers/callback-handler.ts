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
import { Markup } from 'telegraf'
import type { AIModelSelection } from '../../types/index.js'
import { formatAILabel, resolveBackend } from '../../ai/types.js'

export async function callbackHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return

  const data = ctx.callbackQuery.data
  if (!data) return

  if (data.startsWith('confirm:')) {
    await handleConfirm(ctx, chatId, data)
  } else if (data.startsWith('choice:')) {
    await handleChoice(ctx, chatId, data)
  } else if (data.startsWith('suggest:')) {
    await handleSuggestion(ctx, chatId, data)
  } else if (data.startsWith('project:')) {
    await handleProjectSelect(ctx, chatId, data.slice('project:'.length))
  } else if (data.startsWith('ai:')) {
    await handleAISelect(ctx, chatId, data.slice('ai:'.length))
  } else if (data.startsWith('model:')) {
    // Backward compat: old model:xxx callbacks → translate to ai:claude:xxx
    await handleAISelect(ctx, chatId, `claude:${data.slice('model:'.length)}`)
  } else if (data.startsWith('resume:')) {
    await handleResume(ctx, chatId, data)
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

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined

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

async function handleAISelect(ctx: BotContext, chatId: number, payload: string): Promise<void> {
  // payload format: "auto:auto" or "claude:sonnet" or "gemini:flash"
  const parts = payload.split(':')
  if (parts.length !== 2) {
    await ctx.answerCbQuery('\u{7121}\u{6548}\u{7684}\u{9078}\u{64C7}')
    return
  }
  const [backend, model] = parts
  const ai: AIModelSelection = { backend: backend as AIModelSelection['backend'], model }

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
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
  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
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

async function handleConfirm(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const answer = data === 'confirm:yes' ? '是，請繼續' : '不用了'

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  // Remove buttons
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.answerCbQuery(`已回答: ${answer}`)

  if (!state.selectedProject) {
    await ctx.telegram.sendMessage(chatId, '⚠️ 尚未選擇專案')
    return
  }

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), state.selectedProject.path)

  enqueue({
    chatId,
    prompt: answer,
    project: state.selectedProject,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleChoice(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const index = parseInt(data.slice('choice:'.length), 10)

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.answerCbQuery('\u5C1A\u672A\u9078\u64C7\u5C08\u6848')
    return
  }

  const choice = getChoice(chatId, state.selectedProject.path, index)
  if (!choice) {
    await ctx.answerCbQuery('\u9078\u9805\u5DF2\u904E\u671F')
    return
  }

  // Remove buttons and show selected choice
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.answerCbQuery()

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), state.selectedProject.path)
  clearChoices(chatId, state.selectedProject.path)

  enqueue({
    chatId,
    prompt: choice,
    project: state.selectedProject,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

async function handleSuggestion(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const index = parseInt(data.slice('suggest:'.length), 10)

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.answerCbQuery('尚未選擇專案')
    return
  }

  const suggestion = getSuggestion(chatId, state.selectedProject.path, index)
  if (!suggestion) {
    await ctx.answerCbQuery('建議已過期')
    return
  }

  // Remove buttons
  await ctx.editMessageText(`💡 → ${suggestion}`).catch(() => {})
  await ctx.answerCbQuery()

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), state.selectedProject.path)
  clearSuggestions(chatId, state.selectedProject.path)

  enqueue({
    chatId,
    prompt: suggestion,
    project: state.selectedProject,
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

async function handleResume(ctx: BotContext, chatId: number, data: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (data === 'resume:yes') {
    if (!state.selectedProject) {
      await ctx.editMessageText('\u{26A0}\u{FE0F} \u{5C08}\u{6848}\u{5DF2}\u{4E0D}\u{5B58}\u{5728}\uFF0C\u{8ACB}\u{91CD}\u{65B0} /projects')
      await ctx.answerCbQuery()
      return
    }

    await ctx.editMessageText(
      `\u{2705} \u{7E7C}\u{7E8C} *${state.selectedProject.name}*`,
      { parse_mode: 'Markdown' },
    )
    await ctx.answerCbQuery()

    const sessionId = getAISessionId(resolveBackend(state.ai.backend), state.selectedProject.path)
    enqueue({
      chatId,
      prompt: '\u{7E7C}\u{7E8C}\u{4E0A}\u{6B21}\u{7684}\u{5DE5}\u{4F5C}',
      project: state.selectedProject,
      ai: state.ai,
      sessionId,
      imagePaths: [],
    })
  } else {
    const name = state.selectedProject?.name ?? '\u{7121}'
    await ctx.editMessageText(
      `\u{1F44C} OK\uFF0C\u{5C08}\u{6848}\u{4FDD}\u{7559}\u{5728} *${name}*\uFF0C\u{96A8}\u{6642}\u{53EF}\u{4EE5}\u{958B}\u{59CB}\u{3002}`,
      { parse_mode: 'Markdown' },
    )
    await ctx.answerCbQuery().catch(() => {})
  }
}
