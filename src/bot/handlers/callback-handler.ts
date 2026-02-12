import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { validateProjectPath } from '../../utils/path-validator.js'
import { getUserState, setUserProject, setUserModel } from '../state.js'
import type { ClaudeModel } from '../../types/index.js'

const VALID_MODELS = new Set<ClaudeModel>(['haiku', 'sonnet', 'opus'])

export async function callbackHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return

  const data = ctx.callbackQuery.data
  if (!data) return

  if (data.startsWith('project:')) {
    await handleProjectSelect(ctx, chatId, data.slice('project:'.length))
  } else if (data.startsWith('model:')) {
    await handleModelSelect(ctx, chatId, data.slice('model:'.length))
  }

  await ctx.answerCbQuery()
}

async function handleProjectSelect(ctx: BotContext, chatId: number, name: string): Promise<void> {
  const project = findProject(name)
  if (!project) {
    await ctx.answerCbQuery(`Project "${name}" not found`)
    return
  }

  validateProjectPath(project.path)
  setUserProject(chatId, project)
  const state = getUserState(chatId)

  await ctx.editMessageText(
    `✅ Selected: *${project.name}*\nModel: ${state.model}\n\nSend a message to start chatting with Claude.`,
    { parse_mode: 'Markdown' }
  )
}

async function handleModelSelect(ctx: BotContext, chatId: number, model: string): Promise<void> {
  if (!VALID_MODELS.has(model as ClaudeModel)) {
    await ctx.answerCbQuery('Invalid model')
    return
  }

  setUserModel(chatId, model as ClaudeModel)

  await ctx.editMessageText(`✅ Model switched to *${model}*`, { parse_mode: 'Markdown' })
}
