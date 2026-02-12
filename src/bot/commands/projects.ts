import type { BotContext } from '../../types/context.js'
import { scanProjects } from '../../config/projects.js'
import { buildProjectKeyboard } from '../../telegram/keyboard-builder.js'

export async function projectsCommand(ctx: BotContext): Promise<void> {
  const projects = scanProjects()

  if (projects.length === 0) {
    await ctx.reply('No projects found in the configured directory.')
    return
  }

  const keyboard = buildProjectKeyboard(projects)
  await ctx.reply(`📁 Select a project (${projects.length} found):`, keyboard)
}
