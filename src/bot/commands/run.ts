import type { BotContext } from '../../types/context.js'
import { findProject } from '../../config/projects.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue, isProcessing, getQueueLength } from '../../claude/queue.js'
import { getUserState } from '../state.js'

export async function runCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const rest = raw.replace(/^\/run\s*/, '').trim()

  if (!rest) {
    await ctx.reply(
      '用法: `/run <專案> <提示>`\n範例: `/run weetube 更新 API endpoint`\n\n支援模糊匹配：`wee` → weetube',
      { parse_mode: 'Markdown' }
    )
    return
  }

  // Try progressively longer prefixes as project name
  // e.g., "my project do something" → try "my", then "my project", etc.
  const words = rest.split(/\s+/)
  let project = null
  let splitAt = 0

  for (let i = 1; i <= Math.min(words.length - 1, 4); i++) {
    const candidate = words.slice(0, i).join(' ')
    const found = findProject(candidate)
    if (found) {
      project = found
      splitAt = i
      break
    }
  }

  if (!project) {
    // Last resort: try first word only and show error
    const firstWord = words[0]
    await ctx.reply(
      `❌ 找不到專案 "${firstWord}"。\n用 /projects 查看可用專案。\n\n支援模糊匹配：輸入部分名稱即可。`,
    )
    return
  }

  const prompt = words.slice(splitAt).join(' ').trim()

  if (!prompt) {
    await ctx.reply(
      '❌ 請提供提示內容。\n用法: `/run <專案> <提示>`',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined
  const state = getUserState(chatId, threadId)
  const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
  const sessionId = getAISessionId(resolvedBackend, project.path)

  enqueue({
    chatId,
    prompt,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  const busy = isProcessing(project.path)
  const qLen = getQueueLength(project.path)

  if (busy) {
    await ctx.reply(
      `📤 [${project.name}] 已加入佇列 (前方 ${qLen} 個)\n提示: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`
    )
  } else {
    await ctx.reply(
      `🚀 [${project.name}] 跨專案執行中\n提示: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`
    )
  }
}
