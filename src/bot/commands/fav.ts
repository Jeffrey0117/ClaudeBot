import type { BotContext } from '../../types/context.js'
import { getBookmarks, addBookmark, removeBookmark } from '../bookmarks.js'
import { getUserState } from '../state.js'
import { findProject } from '../../config/projects.js'
import { Markup } from 'telegraf'

export async function favCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.split(/\s+/).slice(1)
  const subcommand = args[0]?.toLowerCase()

  if (subcommand === 'add') {
    const projectName = args.slice(1).join(' ').trim()
    await handleAdd(ctx, chatId, projectName)
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    const slot = parseInt(args[1], 10)
    await handleRemove(ctx, chatId, slot)
  } else {
    await showBookmarks(ctx, chatId)
  }
}

async function handleAdd(ctx: BotContext, chatId: number, projectName: string): Promise<void> {
  let project

  if (projectName) {
    // /fav add <name> — find project by name
    project = findProject(projectName)
    if (!project) {
      await ctx.reply(`\u{274C} \u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${projectName}"\u{3002}\u{7528} /projects \u{67E5}\u{770B}\u{53EF}\u{7528}\u{5C08}\u{6848}\u{3002}`)
      return
    }
  } else {
    // /fav add — use currently selected project
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    project = state.selectedProject

    if (!project) {
      await ctx.reply('\u{7528}\u{6CD5}: `/fav add <\u{5C08}\u{6848}\u{540D}\u{7A31}>` \u{6216}\u{5148}\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\u{518D} `/fav add`', { parse_mode: 'Markdown' })
      return
    }
  }

  const slot = addBookmark(chatId, project)
  if (slot === null) {
    await ctx.reply('\u{5DF2}\u{5B58}\u{5728}\u{6216}\u{5DF2}\u{9054}\u{4E0A}\u{9650} 9 \u{500B}\u{3002}')
    return
  }

  await ctx.reply(`\u{2705} \u{5DF2}\u{5C07} *${project.name}* \u{52A0}\u{5165}\u{66F8}\u{7C64} /${slot}`, { parse_mode: 'Markdown' })
}

async function handleRemove(ctx: BotContext, chatId: number, slot: number): Promise<void> {
  if (!slot || isNaN(slot)) {
    await ctx.reply('\u{7528}\u{6CD5}: `/fav remove <\u{7DE8}\u{865F}>`\n\u{7BC4}\u{4F8B}: `/fav remove 3`', { parse_mode: 'Markdown' })
    return
  }

  const removed = removeBookmark(chatId, slot)
  if (!removed) {
    await ctx.reply(`\u{66F8}\u{7C64} ${slot} \u{4E0D}\u{5B58}\u{5728}\u{3002}`)
    return
  }

  await ctx.reply(`\u{2705} \u{5DF2}\u{79FB}\u{9664}\u{66F8}\u{7C64} ${slot}\u{3002}`)
}

async function showBookmarks(ctx: BotContext, chatId: number): Promise<void> {
  const bookmarks = getBookmarks(chatId)

  if (bookmarks.length === 0) {
    await ctx.reply(
      '\u{9084}\u{6C92}\u{6709}\u{66F8}\u{7C64}\u{3002}\n\n\u{5148}\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\u{FF0C}\u{518D}\u{7528} `/fav add` \u{52A0}\u{5165}\u{66F8}\u{7C64}\u{3002}',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ \u{52A0}\u{5165}\u{76EE}\u{524D}\u{5C08}\u{6848}', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`\u{79FB}\u{9664} /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]

  await ctx.reply(
    `*\u{66F8}\u{7C64}*\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }
  )
}
