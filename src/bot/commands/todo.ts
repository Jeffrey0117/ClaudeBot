import type { BotContext } from '../../types/context.js'
import { addTodo, getTodos, toggleTodo, clearDone } from '../todo-store.js'
import { getUserState } from '../state.js'
import { findProject } from '../../config/projects.js'

export async function todoCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const content = text.replace(/^\/todo\s*/, '').trim()

  if (!content) {
    await ctx.reply('Usage: `/todo <text>` or `/todo @project <text>`', { parse_mode: 'Markdown' })
    return
  }

  // Check for @projectname prefix
  const atMatch = content.match(/^@(\S+)\s+(.+)/)
  let projectPath: string | null = null
  let todoText: string

  if (atMatch) {
    const projectName = atMatch[1]
    todoText = atMatch[2]
    const project = findProject(projectName)
    if (!project) {
      await ctx.reply(`Project "${projectName}" not found.`)
      return
    }
    projectPath = project.path
  } else {
    todoText = content
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('No project selected. Use /projects first, or use `/todo @project <text>`', { parse_mode: 'Markdown' })
      return
    }
    projectPath = state.selectedProject.path
  }

  const item = addTodo(projectPath, todoText)
  const todos = getTodos(projectPath)
  await ctx.reply(`Added todo #${todos.length}: ${item.text}`)
}

export async function todosCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const arg = text.replace(/^\/todos\s*/, '').trim()

  let projectPath: string | null = null
  let projectName: string

  if (arg.startsWith('@')) {
    const name = arg.slice(1)
    const project = findProject(name)
    if (!project) {
      await ctx.reply(`Project "${name}" not found.`)
      return
    }
    projectPath = project.path
    projectName = project.name
  } else if (arg === 'done') {
    // /todos done → clear completed todos
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('No project selected.')
      return
    }
    const cleared = clearDone(state.selectedProject.path)
    await ctx.reply(`Cleared ${cleared} completed todo${cleared !== 1 ? 's' : ''}.`)
    return
  } else if (arg.match(/^\d+$/)) {
    // /todos <number> → toggle todo
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('No project selected.')
      return
    }
    const index = parseInt(arg, 10) - 1
    const toggled = toggleTodo(state.selectedProject.path, index)
    if (!toggled) {
      await ctx.reply(`Invalid todo number: ${arg}`)
      return
    }
    const todos = getTodos(state.selectedProject.path)
    const item = todos[index]
    const status = item.done ? 'done' : 'not done'
    await ctx.reply(`Todo #${parseInt(arg, 10)} marked as ${status}: ${item.text}`)
    return
  } else {
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('No project selected. Use /projects first, or use `/todos @project`', { parse_mode: 'Markdown' })
      return
    }
    projectPath = state.selectedProject.path
    projectName = state.selectedProject.name
  }

  const todos = getTodos(projectPath)

  if (todos.length === 0) {
    await ctx.reply(`No todos for *${projectName}*.\nUse \`/todo <text>\` to add one.`, { parse_mode: 'Markdown' })
    return
  }

  const lines = todos.map((t, i) => {
    const check = t.done ? '\u2611' : '\u2610'
    return `${check} ${i + 1}. ${t.text}`
  })

  await ctx.reply(
    `Todos \u2014 ${projectName}\n\n${lines.join('\n')}\n\n/todos <num> toggle | /todos done clear`
  )
}
