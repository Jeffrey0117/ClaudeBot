import type { BotContext } from '../../types/context.js'
import { getBookmarks, addBookmark, addBookmarkAt, removeBookmark, swapBookmarks } from '../bookmarks.js'
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
    await handleAdd(ctx, chatId, args.slice(1))
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    const slot = parseInt(args[1], 10)
    await handleRemove(ctx, chatId, slot)
  } else if (subcommand === 'swap') {
    const a = parseInt(args[1], 10)
    const b = parseInt(args[2], 10)
    await handleSwap(ctx, chatId, a, b)
  } else if (subcommand === 'list' || subcommand === 'ls') {
    await showBookmarks(ctx, chatId)
  } else {
    await showBookmarks(ctx, chatId)
  }
}

async function handleAdd(ctx: BotContext, chatId: number, args: string[]): Promise<void> {
  // Parse: /fav add <name> [slot] or /fav add [slot]
  // Last arg might be a slot number
  const lastArg = args[args.length - 1]
  const lastIsSlot = args.length > 0 && /^\d+$/.test(lastArg)

  let targetSlot: number | null = null
  let nameArgs: string[]

  if (lastIsSlot && args.length >= 2) {
    // /fav add claudebot 3
    targetSlot = parseInt(lastArg, 10)
    nameArgs = args.slice(0, -1)
  } else if (lastIsSlot && args.length === 1) {
    // /fav add 3 — just a slot, use current project
    targetSlot = parseInt(lastArg, 10)
    nameArgs = []
  } else {
    // /fav add claudebot or /fav add
    nameArgs = args
  }

  const projectName = nameArgs.join(' ').trim()
  let project

  if (projectName) {
    project = findProject(projectName)
    if (!project) {
      await ctx.reply(`\u{274C} \u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${projectName}"\u{3002}\u{7528} /projects \u{67E5}\u{770B}\u{53EF}\u{7528}\u{5C08}\u{6848}\u{3002}`)
      return
    }
  } else {
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    project = state.selectedProject

    if (!project) {
      await ctx.reply('\u{7528}\u{6CD5}: `/fav add <\u{540D}\u{7A31}> [\\u{4F4D}\u{7F6E}]`\n\u{7BC4}\u{4F8B}: `/fav add claudebot 3`', { parse_mode: 'Markdown' })
      return
    }
  }

  if (targetSlot !== null) {
    const ok = addBookmarkAt(chatId, project, targetSlot)
    if (!ok) {
      await ctx.reply('\u{5DF2}\u{5B58}\u{5728}\u{3001}\u{4F4D}\u{7F6E}\u{7121}\u{6548}\u{6216}\u{5DF2}\u{9054}\u{4E0A}\u{9650} 9 \u{500B}\u{3002}')
      return
    }
    await ctx.reply(`\u{2705} \u{5DF2}\u{5C07} *${project.name}* \u{52A0}\u{5165}\u{66F8}\u{7C64} /${targetSlot}`, { parse_mode: 'Markdown' })
  } else {
    const slot = addBookmark(chatId, project)
    if (slot === null) {
      await ctx.reply('\u{5DF2}\u{5B58}\u{5728}\u{6216}\u{5DF2}\u{9054}\u{4E0A}\u{9650} 9 \u{500B}\u{3002}')
      return
    }
    await ctx.reply(`\u{2705} \u{5DF2}\u{5C07} *${project.name}* \u{52A0}\u{5165}\u{66F8}\u{7C64} /${slot}`, { parse_mode: 'Markdown' })
  }
}

async function handleSwap(ctx: BotContext, chatId: number, a: number, b: number): Promise<void> {
  if (!a || !b || isNaN(a) || isNaN(b)) {
    await ctx.reply('\u{7528}\u{6CD5}: `/fav swap <A> <B>`\n\u{7BC4}\u{4F8B}: `/fav swap 1 3`', { parse_mode: 'Markdown' })
    return
  }

  const ok = swapBookmarks(chatId, a, b)
  if (!ok) {
    await ctx.reply(`\u{274C} \u{7121}\u{6CD5}\u{4EA4}\u{63DB}\u{3002}\u{8ACB}\u{78BA}\u{8A8D}\u{66F8}\u{7C64} ${a} \u{548C} ${b} \u{90FD}\u{5B58}\u{5728}\u{3002}`)
    return
  }

  const bookmarks = getBookmarks(chatId)
  await ctx.reply(
    `\u{2705} \u{5DF2}\u{4EA4}\u{63DB}\n/${a} ${bookmarks[a - 1]?.name}\n/${b} ${bookmarks[b - 1]?.name}`
  )
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
      '\u{9084}\u{6C92}\u{6709}\u{66F8}\u{7C64}\u{3002}\n\n`/fav add <\u{540D}\u{7A31}>` \u{52A0}\u{5165}\u{66F8}\u{7C64}\u{3002}',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const lines = bookmarks.map((b, i) => `/${i + 1} \u{2014} ${b.name}`)
  const buttons = [
    [Markup.button.callback('+ \u{52A0}\u{5165}\u{76EE}\u{524D}\u{5C08}\u{6848}', 'bookmark:add')],
    ...bookmarks.map((_, i) =>
      [Markup.button.callback(`\u{79FB}\u{9664} /${i + 1}`, `bookmark:remove:${i + 1}`)]
    ),
  ]

  await ctx.reply(
    `*\u{2B50} \u{66F8}\u{7C64}*\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }
  )
}
