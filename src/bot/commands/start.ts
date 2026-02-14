import type { BotContext } from '../../types/context.js'
import { isAuthenticated } from '../../auth/auth-service.js'
import { getBookmarks } from '../bookmarks.js'

function buildBookmarkList(chatId: number): string {
  const bookmarks = getBookmarks(chatId)
  if (bookmarks.length === 0) return ''

  const lines = bookmarks.map((b, i) => `/${i + 1} ${b.name}`)
  return `\n\n*\u{5FEB}\u{901F}\u{5207}\u{63DB}:*\n${lines.join('\n')}\n\u{2192} /fav \u{7BA1}\u{7406}\u{66F8}\u{7C64}`
}

const WELCOME_BACK_BASE = `
*\u{6B61}\u{8FCE}\u{56DE}\u{4F86}!* \u{1F44B}

\u{5DF2}\u{767B}\u{5165}\u{FF0C}\u{96A8}\u{6642}\u{53EF}\u{4EE5}\u{958B}\u{59CB}\u{3002}
\u{2192} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}
\u{2192} /status \u{67E5}\u{770B}\u{72C0}\u{614B}
\u{2192} /help \u{6240}\u{6709}\u{6307}\u{4EE4}
`.trim()

const WELCOME_NEW = `
\u{1F916} *ClaudeBot*
_\u{624B}\u{6A5F}\u{9059}\u{63A7} Claude Code CLI_

\u{7528}\u{624B}\u{6A5F}\u{63A7}\u{5236} Claude Code\u{3002}
\u{50B3}\u{9001}\u{63D0}\u{793A}\u{3001}\u{5373}\u{6642}\u{4E32}\u{6D41}\u{56DE}\u{61C9}\u{3001}\u{7BA1}\u{7406}\u{591A}\u{500B}\u{5C08}\u{6848}\u{3002}

\u{1F512} /login \`<\u{5BC6}\u{78BC}>\` \u{958B}\u{59CB}\u{4F7F}\u{7528}
_(\u{8A0A}\u{606F}\u{6703}\u{81EA}\u{52D5}\u{522A}\u{9664})_
`.trim()

export async function startCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  if (isAuthenticated(chatId)) {
    const bookmarkList = buildBookmarkList(chatId)
    await ctx.reply(WELCOME_BACK_BASE + bookmarkList, { parse_mode: 'Markdown' })
    return
  }

  await ctx.reply(WELCOME_NEW, { parse_mode: 'Markdown' })
}
