import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { getUserState, setUserProject, setUserModel } from '../state.js'
import { addBookmark, removeBookmark, getBookmarks } from '../bookmarks.js'
import { updateBotBio, pinProjectStatus } from '../bio-updater.js'
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
    `\u{2705} \u{5DF2}\u{9078}\u{64C7}: *${project.name}*\n\u{6A21}\u{578B}: ${state.model}\n\n\u{50B3}\u{9001}\u{8A0A}\u{606F}\u{958B}\u{59CB}\u{8207} Claude \u{5C0D}\u{8A71}\u{3002}`,
    { parse_mode: 'Markdown' }
  )
  await ctx.answerCbQuery()

  await updateBotBio(project)
  await pinProjectStatus(chatId, project, state.model)
}

async function handleModelSelect(ctx: BotContext, chatId: number, model: string): Promise<void> {
  if (!VALID_MODELS.has(model as ClaudeModel)) {
    await ctx.answerCbQuery('\u{7121}\u{6548}\u{7684}\u{6A21}\u{578B}')
    return
  }

  const msg = ctx.callbackQuery?.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  setUserModel(chatId, model as ClaudeModel, threadId)

  await ctx.editMessageText(`\u{2705} \u{6A21}\u{578B}\u{5DF2}\u{5207}\u{63DB}\u{70BA} *${model}*`, { parse_mode: 'Markdown' })
  await ctx.answerCbQuery()
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
