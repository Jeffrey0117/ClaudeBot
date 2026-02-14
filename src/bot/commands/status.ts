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
  const projectName = project ? project.name : '(\u{7121})'
  const sessionId = project ? getSessionId(project.path) : null

  const activePaths = getActiveProjectPaths()
  const activeList = activePaths.length > 0
    ? activePaths.map(p => {
        const name = path.basename(p)
        const elapsed = (getElapsedMs(p) / 1000).toFixed(0)
        const qLen = getQueueLength(p)
        const qInfo = qLen > 0 ? ` | \u{4F47}\u{5217}: ${qLen}` : ''
        return `  \u{1F7E2} ${name} (${elapsed}\u{79D2}${qInfo})`
      }).join('\n')
    : '  \u{1F534} \u{7121}'

  const totalQueue = getQueueLength()

  const lines = [
    `\u{1F4CA} *\u{72C0}\u{614B}*`,
    ``,
    `\u{1F4C1} \u{5C08}\u{6848}: *${projectName}*`,
    `\u{1F916} \u{6A21}\u{578B}: \`${state.model}\``,
    `\u{1F4BE} \u{5C0D}\u{8A71}: ${sessionId ? '\u{2705} \u{9032}\u{884C}\u{4E2D}' : '\u{26AA} \u{7121}'}`,
    ``,
    `*\u{904B}\u{884C}\u{4E2D}:*`,
    activeList,
    ``,
    `\u{4F47}\u{5217}: ${totalQueue} \u{500B}\u{7B49}\u{5F85}\u{4E2D}`,
  ]

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}
