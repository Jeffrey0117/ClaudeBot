import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { getUserState, setUserProject } from '../state.js'

export async function selectCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = text?.split(' ').slice(1).join(' ').trim() ?? ''

  if (!name) {
    await ctx.reply('\u{7528}\u{6CD5}: /select <\u{5C08}\u{6848}\u{540D}\u{7A31}>\n\u{6216}\u{7528} /projects \u{700F}\u{89BD}\u{5217}\u{8868}\u{3002}')
    return
  }

  const project = findProject(name)
  if (!project) {
    await ctx.reply(`\u{274C} \u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${name}"\u{3002}\u{7528} /projects \u{67E5}\u{770B}\u{53EF}\u{7528}\u{5C08}\u{6848}\u{3002}`)
    return
  }

  validateProjectPath(project.path)
  setUserProject(chatId, project)

  const state = getUserState(chatId)
  await ctx.reply(
    `\u{2705} \u{5DF2}\u{9078}\u{64C7}: *${project.name}*\n\u{6A21}\u{578B}: ${state.model}\n\n\u{50B3}\u{9001}\u{8A0A}\u{606F}\u{958B}\u{59CB}\u{8207} Claude \u{5C0D}\u{8A71}\u{3002}`,
    { parse_mode: 'Markdown' }
  )
}
