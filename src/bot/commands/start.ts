import type { BotContext } from '../../types/context.js'
import { isAuthenticated } from '../../auth/auth-service.js'
import { getBookmarks } from '../bookmarks.js'

function buildBookmarkList(chatId: number): string {
  const bookmarks = getBookmarks(chatId)
  if (bookmarks.length === 0) return ''

  const lines = bookmarks.map((b, i) => `/${i + 1} ${b.name}`)
  return `\n\n*Quick access:*\n${lines.join('\n')}\n→ /fav to manage bookmarks`
}

const WELCOME_BACK_BASE = `
*Welcome back!* \u{1F44B}

You're logged in. Ready to go.
\u{2192} /projects to select a project
\u{2192} /status to see what's running
\u{2192} /help for all commands
`.trim()

const WELCOME_NEW = `
\u{1F916} *ClaudeBot*
_Remote Claude Code CLI_

Control Claude Code from your phone.
Send prompts, get streaming responses, manage multiple projects.

\u{1F512} /login \`<password>\` to get started
_(message auto-deletes)_
`.trim()

export async function startCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  if (isAuthenticated(chatId)) {
    const bookmarkList = buildBookmarkList(chatId)
    await ctx.reply(WELCOME_BACK_BASE + bookmarkList, { parse_mode: 'Markdown' })
    return
  }

  // If AUTO_AUTH is on, the auth middleware will have already authenticated them
  // so we'd never reach here with AUTO_AUTH enabled. Show login prompt.
  await ctx.reply(WELCOME_NEW, { parse_mode: 'Markdown' })
}
