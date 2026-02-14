import type { BotContext } from '../../types/context.js'
import { scanProjects } from '../../config/projects.js'
import { buildProjectKeyboard } from '../../telegram/keyboard-builder.js'

export async function projectsCommand(ctx: BotContext): Promise<void> {
  const projects = scanProjects()

  if (projects.length === 0) {
    await ctx.reply('\u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848}\u{3002}\u{8ACB}\u{6AA2}\u{67E5} PROJECTS_BASE_DIR \u{8A2D}\u{5B9A}\u{3002}')
    return
  }

  const keyboard = buildProjectKeyboard(projects)
  await ctx.reply(`\u{1F4C1} \u{9078}\u{64C7}\u{5C08}\u{6848} (\u{5171} ${projects.length} \u{500B}):`, keyboard)
}
