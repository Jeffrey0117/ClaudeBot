import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isProcessing, getQueueLength, getActiveProjectPaths } from '../../claude/queue.js'
import { getSessionId } from '../../claude/session-store.js'
import { getElapsedMs } from '../../claude/claude-runner.js'
import path from 'node:path'

export async function statusCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
  const projectName = project ? project.name : '(none)'
  const sessionId = project ? getSessionId(project.path) : null

  const activePaths = getActiveProjectPaths()
  const activeList = activePaths.length > 0
    ? activePaths.map(p => {
        const name = path.basename(p)
        const elapsed = (getElapsedMs(p) / 1000).toFixed(0)
        const qLen = getQueueLength(p)
        const qInfo = qLen > 0 ? ` | queue: ${qLen}` : ''
        return `  \u{1F7E2} ${name} (${elapsed}s${qInfo})`
      }).join('\n')
    : '  \u{1F534} None'

  const totalQueue = getQueueLength()

  const lines = [
    `\u{1F4CA} *Status*`,
    ``,
    `\u{1F4C1} Selected: *${projectName}*`,
    `\u{1F916} Model: \`${state.model}\``,
    `\u{1F4BE} Session: ${sessionId ? '\u{2705} Active' : '\u{26AA} None'}`,
    ``,
    `*Running:*`,
    activeList,
    ``,
    `Queue: ${totalQueue} pending`,
  ]

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}
