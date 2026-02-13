import type { BotContext } from '../../types/context.js'
import { isAuthenticated } from '../../auth/auth-service.js'

const WELCOME_BACK = `
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
    await ctx.reply(WELCOME_BACK, { parse_mode: 'Markdown' })
    return
  }

  await ctx.reply(WELCOME_NEW, { parse_mode: 'Markdown' })
}
