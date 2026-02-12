import type { BotContext } from '../../types/context.js'
import { cancelRunning, isRunning } from '../../claude/claude-runner.js'

export async function cancelCommand(ctx: BotContext): Promise<void> {
  if (!isRunning()) {
    await ctx.reply('💤 No Claude process is currently running.')
    return
  }

  const cancelled = cancelRunning()
  if (cancelled) {
    await ctx.reply('🛑 Claude process cancelled.')
  } else {
    await ctx.reply('⚠️ Could not cancel the process.')
  }
}
