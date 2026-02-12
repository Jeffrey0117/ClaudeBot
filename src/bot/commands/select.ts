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
    await ctx.reply('Usage: /select <project-name>\nOr use /projects to pick from a list.')
    return
  }

  const project = findProject(name)
  if (!project) {
    await ctx.reply(`❌ Project "${name}" not found. Use /projects to see available projects.`)
    return
  }

  validateProjectPath(project.path)
  setUserProject(chatId, project)

  const state = getUserState(chatId)
  await ctx.reply(
    `✅ Selected: *${project.name}*\nModel: ${state.model}\n\nSend a message to start chatting with Claude.`,
    { parse_mode: 'Markdown' }
  )
}
