import type { BotContext } from '../../types/context.js'

const HELP_TEXT = `
*ClaudeBot Commands*

/start - Welcome message
/login <password> - Authenticate (auto-deletes password)
/logout - Log out
/projects - List & select projects (inline keyboard)
/select <name> - Select project by name
/status - Current project, model, queue status
/model - Switch Claude model (haiku/sonnet/opus)
/cancel - Cancel running Claude process
/new - Clear session, start fresh conversation
/help - Show this help

*Usage:*
1. /login with your password
2. /projects to pick a project
3. Send any text message to chat with Claude
4. Claude responds with streaming updates

Messages are queued - one Claude process runs at a time.
`.trim()

export async function helpCommand(ctx: BotContext): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' })
}
