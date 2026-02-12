import type { BotContext } from '../../types/context.js'
import { isAuthenticated } from '../../auth/auth-service.js'

export async function startCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  if (isAuthenticated(chatId)) {
    await ctx.reply(
      'Welcome back! You are already logged in.\n\n' +
        'Use /projects to select a project, then send messages to Claude.\n' +
        'Type /help for all commands.'
    )
    return
  }

  await ctx.reply(
    'Welcome to ClaudeBot! 🤖\n\n' +
      'This bot lets you remotely control Claude Code CLI.\n\n' +
      'Please /login <password> to get started.\n' +
      '(Your password message will be auto-deleted)'
  )
}
