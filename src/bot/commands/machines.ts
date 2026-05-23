import type { BotContext } from '../../types/context.js'
import { getPairings } from '../../remote/pairing-store.js'
import { getActiveMachine } from '../state.js'
import { getAgentBaseDir } from '../../remote/relay-server.js'
import { Markup } from 'telegraf'

export async function machinesCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const pairings = getPairings(chatId, threadId)

  if (pairings.length === 0) {
    await ctx.reply('目前沒有配對的機器。用 /pair 開始配對。')
    return
  }

  const activeMch = getActiveMachine(chatId, threadId)
  const lines: string[] = []
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  for (const s of pairings) {
    const label = s.label || s.code
    const isActive = s.label === activeMch
    const icon = s.connected ? (isActive ? '✅' : '🔗') : '⭕'
    const activeTag = isActive ? ' ← active' : ''

    // Try to get base dir from relay (only works if connected)
    const baseDir = s.connected ? getAgentBaseDir(s.code) : undefined
    const dirInfo = baseDir ? ` — ${baseDir}` : ''

    lines.push(`${icon} *${label}*${dirInfo}${activeTag}`)

    if (s.connected && !isActive) {
      buttons.push([Markup.button.callback(`切換到 ${label}`, `machine:${label}`)])
    }
  }

  const msg = `🖥️ *已配對機器:*\n${lines.join('\n')}`
  const opts = buttons.length > 0
    ? { parse_mode: 'Markdown' as const, ...Markup.inlineKeyboard(buttons) }
    : { parse_mode: 'Markdown' as const }

  await ctx.reply(msg, opts)
}
