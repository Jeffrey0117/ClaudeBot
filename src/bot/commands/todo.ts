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
    await ctx.reply('\u{7528}\u{6CD5}: `/todo <\u{5167}\u{5BB9}>` \u{6216} `/todo @\u{5C08}\u{6848}\u{540D} <\u{5167}\u{5BB9}>`', { parse_mode: 'Markdown' })
    return
  }

  const atMatch = content.match(/^@(\S+)\s+(.+)/)
  let projectPath: string | null = null
  let todoText: string

  if (atMatch) {
    const projectName = atMatch[1]
    todoText = atMatch[2]
    const project = findProject(projectName)
    if (!project) {
      await ctx.reply(`\u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${projectName}"\u{3002}`)
      return
    }
    projectPath = project.path
  } else {
    todoText = content
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}\u{8ACB}\u{5148}\u{7528} /projects\u{FF0C}\u{6216}\u{7528} `/todo @\u{5C08}\u{6848}\u{540D} <\u{5167}\u{5BB9}>`', { parse_mode: 'Markdown' })
      return
    }
    projectPath = state.selectedProject.path
  }

  const item = addTodo(projectPath, todoText)
  const todos = getTodos(projectPath)
  await ctx.reply(`\u{2705} \u{5DF2}\u{65B0}\u{589E}\u{5F85}\u{8FA6} #${todos.length}: ${item.text}`)
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
      await ctx.reply(`\u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848} "${name}"\u{3002}`)
      return
    }
    projectPath = project.path
    projectName = project.name
  } else if (arg === 'done') {
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}')
      return
    }
    const cleared = clearDone(state.selectedProject.path)
    await ctx.reply(`\u{2705} \u{5DF2}\u{6E05}\u{9664} ${cleared} \u{500B}\u{5DF2}\u{5B8C}\u{6210}\u{7684}\u{5F85}\u{8FA6}\u{3002}`)
    return
  } else if (arg.match(/^\d+$/)) {
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}')
      return
    }
    const index = parseInt(arg, 10) - 1
    const toggled = toggleTodo(state.selectedProject.path, index)
    if (!toggled) {
      await ctx.reply(`\u{7121}\u{6548}\u{7684}\u{5F85}\u{8FA6}\u{7DE8}\u{865F}: ${arg}`)
      return
    }
    const todos = getTodos(state.selectedProject.path)
    const item = todos[index]
    const status = item.done ? '\u{5DF2}\u{5B8C}\u{6210}' : '\u{672A}\u{5B8C}\u{6210}'
    await ctx.reply(`\u{5F85}\u{8FA6} #${parseInt(arg, 10)} \u{6A19}\u{8A18}\u{70BA}${status}: ${item.text}`)
    return
  } else {
    const msg = ctx.message
    const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
    const state = getUserState(chatId, threadId)
    if (!state.selectedProject) {
      await ctx.reply('\u{5C1A}\u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}\u{3002}\u{8ACB}\u{5148}\u{7528} /projects\u{FF0C}\u{6216}\u{7528} `/todos @\u{5C08}\u{6848}\u{540D}`', { parse_mode: 'Markdown' })
      return
    }
    projectPath = state.selectedProject.path
    projectName = state.selectedProject.name
  }

  const todos = getTodos(projectPath)

  if (todos.length === 0) {
    await ctx.reply(`*${projectName}* \u{6C92}\u{6709}\u{5F85}\u{8FA6}\u{3002}\n\u{7528} \`/todo <\u{5167}\u{5BB9}>\` \u{65B0}\u{589E}\u{3002}`, { parse_mode: 'Markdown' })
    return
  }

  const lines = todos.map((t, i) => {
    const check = t.done ? '\u{2611}' : '\u{2610}'
    return `${check} ${i + 1}. ${t.text}`
  })

  await ctx.reply(
    `\u{5F85}\u{8FA6} \u{2014} ${projectName}\n\n${lines.join('\n')}\n\n/todos <\u{7DE8}\u{865F}> \u{5207}\u{63DB} | /todos done \u{6E05}\u{9664}\u{5DF2}\u{5B8C}\u{6210}`
  )
}
