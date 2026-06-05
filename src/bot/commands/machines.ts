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
  // A bare pairing code with connected=false is NOT a usable machine — the
  // desktop client never connected back. Listing it as a "machine" (it shows
  // the raw 8-char code because label is still empty) is misleading, so we
  // split connected machines from still-waiting codes.
  const connectedMachines = pairings.filter((s) => s.connected)
  const pendingCodes = pairings.filter((s) => !s.connected)

  const lines: string[] = []
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  if (connectedMachines.length > 0) {
    for (const s of connectedMachines) {
      const label = s.label || s.code
      const isActive = s.label === activeMch
      const icon = isActive ? '✅' : '🔗'
      const activeTag = isActive ? ' ← active' : ''
      const baseDir = getAgentBaseDir(s.code)
      const dirInfo = baseDir ? ` — ${baseDir}` : ''
      lines.push(`${icon} *${label}*${dirInfo}${activeTag}`)
      if (!isActive) {
        buttons.push([Markup.button.callback(`切換到 ${label}`, `machine:${label}`)])
      }
    }
  } else {
    lines.push('_(目前沒有已連線的機器)_')
  }

  if (pendingCodes.length > 0) {
    lines.push('')
    lines.push('⏳ *等待連線中的配對碼:*')
    for (const s of pendingCodes) {
      lines.push(`   \`${s.code}\` — 在桌面客戶端貼上此碼`)
    }
    lines.push('_客戶端要指向正確的 relay；連上後這裡才會變主機名。_')
  }

  const msg = `🖥️ *機器狀態:*\n${lines.join('\n')}`
  const opts = buttons.length > 0
    ? { parse_mode: 'Markdown' as const, ...Markup.inlineKeyboard(buttons) }
    : { parse_mode: 'Markdown' as const }

  await ctx.reply(msg, opts)
}
