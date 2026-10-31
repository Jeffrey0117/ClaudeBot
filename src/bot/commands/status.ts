import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isProcessing, getQueueLength, getActiveProjectPaths } from '../../claude/queue.js'
import { getAISessionId, getSessionInfo } from '../../ai/session-store.js'
import { getAnyElapsedMs } from '../../ai/registry.js'
import { formatAILabel, resolveBackend } from '../../ai/types.js'
import path from 'node:path'

/** Humanize a duration in ms to a compact zh-TW string. */
function humanizeMs(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return '剛剛'
  if (min < 60) return `${min} 分鐘`
  const h = Math.floor(min / 60)
  const rem = min % 60
  if (h < 24) return rem > 0 ? `${h} 小時 ${rem} 分` : `${h} 小時`
  return `${Math.floor(h / 24)} 天`
}

export async function statusCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
  const projectName = project ? project.name : '(\u{7121})'
  const resolvedBackend = resolveBackend(state.ai.backend)
  const sessionId = project ? getAISessionId(resolvedBackend, project.path) : null

  // Rich session line: age / turns / context-window occupancy
  let sessionLine = '\u{26AA} \u{7121}（\u{65B0}\u{5C0D}\u{8A71}\u{6703}\u{7528}\u{4E0A}\u{6B21}\u{6458}\u{8981}\u{63A5}\u{7E8C}）'
  if (project && sessionId) {
    const info = getSessionInfo(resolvedBackend, project.path)
    const parts: string[] = ['\u{2705} \u{9032}\u{884C}\u{4E2D}']
    if (info.ageMs > 0) parts.push(`\u{5DF2}\u{6301}\u{7E8C} ${humanizeMs(info.ageMs)}`)
    if (info.promptCount > 0) parts.push(`${info.promptCount} \u{8F2A}`)
    if (info.idleMs > 5 * 60000) parts.push(`\u{9592}\u{7F6E} ${humanizeMs(info.idleMs)}`)
    sessionLine = parts.join(' \u{30FB} ')

    if (info.tokenFraction > 0) {
      const pct = Math.round(info.tokenFraction * 100)
      const bar = info.tokenFraction >= 0.9 ? '\u{1F534}' : info.tokenFraction >= 0.6 ? '\u{1F7E1}' : '\u{1F7E2}'
      sessionLine += `\n\u{1F9E0} context \u{4F54}\u{7528}: ${bar} ${pct}%`
      if (info.tokenFraction >= 0.6) sessionLine += `（\u{63A5}\u{8FD1}\u{4E0A}\u{9650}\u{6703}\u{81EA}\u{52D5}\u{5237}\u{65B0}，\u{6216}\u{6253} /new \u{5F9E}\u{982D}）`
    }
  }

  const activePaths = getActiveProjectPaths()
  const activeList = activePaths.length > 0
    ? activePaths.map(p => {
        const name = path.basename(p)
        const elapsed = (getAnyElapsedMs(p) / 1000).toFixed(0)
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
    `\u{1F916} \u{6A21}\u{578B}: \`${formatAILabel(state.ai)}\``,
    `\u{1F4BE} \u{5C0D}\u{8A71}: ${sessionLine}`,
    ``,
    `*\u{904B}\u{884C}\u{4E2D}:*`,
    activeList,
    ``,
    `\u{4F47}\u{5217}: ${totalQueue} \u{500B}\u{7B49}\u{5F85}\u{4E2D}`,
  ]

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}
