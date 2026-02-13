import type { BotContext } from '../../types/context.js'
import { getBookmark } from '../bookmarks.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { setUserProject, getUserState } from '../state.js'

export async function shortcutCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const slot = parseInt(text.replace('/', ''), 10)

  if (isNaN(slot) || slot < 1 || slot > 9) return

  const project = getBookmark(chatId, slot)
  if (!project) {
    await ctx.reply(`No bookmark in slot /${slot}. Use /fav to set up bookmarks.`)
    return
  }

  const msg = ctx.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined

  try {
    validateProjectPath(project.path)
  } catch {
    await ctx.reply(`Project path no longer valid: ${project.name}`)
    return
  }

  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)

  await ctx.reply(
    `Switched to *${project.name}*\nModel: ${state.model}`,
    { parse_mode: 'Markdown' }
  )
}
