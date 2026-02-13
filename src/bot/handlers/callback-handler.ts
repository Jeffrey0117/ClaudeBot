import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { getUserState, setUserProject, setUserModel } from '../state.js'
import { addBookmark, removeBookmark, getBookmarks } from '../bookmarks.js'
import { Markup } from 'telegraf'
import type { ClaudeModel } from '../../types/index.js'

const VALID_MODELS = new Set<ClaudeModel>(['haiku', 'sonnet', 'opus'])

export async function callbackHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return

  const data = ctx.callbackQuery.data
  if (!data) return

  if (data.startsWith('project:')) {
    await handleProjectSelect(ctx, chatId, data.slice('project:'.length))
  } else if (data.startsWith('model:')) {
    await handleModelSelect(ctx, chatId, data.slice('model:'.length))
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
    await ctx.answerCbQuery(`Project "${name}" not found`)
    return
  }

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined

  try {
    validateProjectPath(project.path)
  } catch {
    await ctx.answerCbQuery('Project path is no longer valid')
    return
  }

  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)

  await ctx.editMessageText(
    `✅ Selected: *${project.name}*\nModel: ${state.model}\n\nSend a message to start chatting with Claude.`,
    { parse_mode: 'Markdown' }
  )
  await ctx.answerCbQuery()
}

async function handleModelSelect(ctx: BotContext, chatId: number, model: string): Promise<void> {
  if (!VALID_MODELS.has(model as ClaudeModel)) {
    await ctx.answerCbQuery('Invalid model')
    return
  }

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  setUserModel(chatId, model as ClaudeModel, threadId)

  await ctx.editMessageText(`✅ Model switched to *${model}*`, { parse_mode: 'Markdown' })
  await ctx.answerCbQuery()
}

async function handleBookmarkAdd(ctx: BotContext, chatId: number): Promise<void> {
  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.answerCbQuery('No project selected')
    return
  }

  const slot = addBookmark(chatId, state.selectedProject)
  if (slot === null) {
    await ctx.answerCbQuery('Already bookmarked or max 9 reached')
    return
  }

  const bookmarks = getBookmarks(chatId)
  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ Add current project', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`Remove /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]
  await ctx.editMessageText(
    `*Bookmarks*\n${lines.join('\n')}\n\n✅ Added ${state.selectedProject.name} to slot /${slot}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
  await ctx.answerCbQuery()
}

async function handleBookmarkRemove(ctx: BotContext, chatId: number, slot: number): Promise<void> {
  if (isNaN(slot)) {
    await ctx.answerCbQuery('Invalid slot')
    return
  }

  const removed = removeBookmark(chatId, slot)
  if (!removed) {
    await ctx.answerCbQuery('No bookmark in that slot')
    return
  }

  const bookmarks = getBookmarks(chatId)
  if (bookmarks.length === 0) {
    await ctx.editMessageText('*Bookmarks*\nNo bookmarks. Use `/fav add` to add one.', { parse_mode: 'Markdown' })
    await ctx.answerCbQuery()
    return
  }

  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ Add current project', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`Remove /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]
  await ctx.editMessageText(
    `*Bookmarks*\n${lines.join('\n')}\n\n✅ Removed slot ${slot}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
  await ctx.answerCbQuery()
}
