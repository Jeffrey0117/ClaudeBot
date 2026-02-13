import type { BotContext } from '../../types/context.js'
import { getBookmarks, addBookmark, removeBookmark } from '../bookmarks.js'
import { getUserState } from '../state.js'
import { Markup } from 'telegraf'

export async function favCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.split(/\s+/).slice(1)
  const subcommand = args[0]?.toLowerCase()

  if (subcommand === 'add') {
    await handleAdd(ctx, chatId)
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    const slot = parseInt(args[1], 10)
    await handleRemove(ctx, chatId, slot)
  } else {
    await showBookmarks(ctx, chatId)
  }
}

async function handleAdd(ctx: BotContext, chatId: number): Promise<void> {
  const msg = ctx.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects first.')
    return
  }

  const slot = addBookmark(chatId, state.selectedProject)
  if (slot === null) {
    await ctx.reply('Bookmark already exists or max 9 reached.')
    return
  }

  await ctx.reply(`Added *${state.selectedProject.name}* to slot /${slot}`, { parse_mode: 'Markdown' })
}

async function handleRemove(ctx: BotContext, chatId: number, slot: number): Promise<void> {
  if (!slot || isNaN(slot)) {
    await ctx.reply('Usage: `/fav remove <slot>`\nExample: `/fav remove 3`', { parse_mode: 'Markdown' })
    return
  }

  const removed = removeBookmark(chatId, slot)
  if (!removed) {
    await ctx.reply(`No bookmark in slot ${slot}.`)
    return
  }

  await ctx.reply(`Removed bookmark from slot ${slot}.`)
}

async function showBookmarks(ctx: BotContext, chatId: number): Promise<void> {
  const bookmarks = getBookmarks(chatId)

  if (bookmarks.length === 0) {
    await ctx.reply(
      'No bookmarks yet.\n\nSelect a project with /projects, then use `/fav add` to bookmark it.',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const lines = bookmarks.map((b, i) => `${i + 1}. ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ Add current project', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`Remove /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]

  await ctx.reply(
    `*Bookmarks*\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }
  )
}
