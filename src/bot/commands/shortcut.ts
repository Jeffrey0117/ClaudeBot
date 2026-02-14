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
    await ctx.reply(`\u{66F8}\u{7C64} /${slot} \u{4E0D}\u{5B58}\u{5728}\u{3002}\u{7528} /fav \u{8A2D}\u{5B9A}\u{66F8}\u{7C64}\u{3002}`)
    return
  }

  const msg = ctx.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined

  try {
    validateProjectPath(project.path)
  } catch {
    await ctx.reply(`\u{5C08}\u{6848}\u{8DEF}\u{5F91}\u{5DF2}\u{5931}\u{6548}: ${project.name}`)
    return
  }

  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)

  await ctx.reply(
    `\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{5230} *${project.name}*\n\u{6A21}\u{578B}: ${state.model}`,
    { parse_mode: 'Markdown' }
  )
}
