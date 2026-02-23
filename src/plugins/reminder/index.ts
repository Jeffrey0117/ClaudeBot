import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'

interface Reminder {
  readonly chatId: number
  readonly text: string
  readonly fireAt: number
  readonly timer: ReturnType<typeof setTimeout>
}

const reminders = new Map<string, Reminder>()
let sendFn: ((chatId: number, text: string) => Promise<void>) | null = null

export function setReminderSendFn(fn: (chatId: number, text: string) => Promise<void>): void {
  sendFn = fn
}

function parseTime(input: string): { ms: number; label: string } | null {
  // "30s", "5m", "2h", "1h30m"
  const parts = input.matchAll(/(\d+)\s*(s|m|h)/gi)
  let totalMs = 0
  const labels: string[] = []

  for (const match of parts) {
    const val = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    if (unit === 's') { totalMs += val * 1000; labels.push(`${val}秒`) }
    if (unit === 'm') { totalMs += val * 60_000; labels.push(`${val}分`) }
    if (unit === 'h') { totalMs += val * 3_600_000; labels.push(`${val}時`) }
  }

  if (totalMs === 0) return null
  return { ms: totalMs, label: labels.join('') }
}

async function reminderCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/remind\s*/, '').trim()

  // /remind list
  if (args === 'list' || args === 'ls') {
    const userReminders = [...reminders.entries()]
      .filter(([, r]) => r.chatId === chatId)
      .map(([id, r]) => {
        const remaining = Math.max(0, r.fireAt - Date.now())
        const mins = Math.ceil(remaining / 60_000)
        return `• ${r.text} (${mins}分後) [${id}]`
      })

    if (userReminders.length === 0) {
      await ctx.reply('📋 沒有進行中的提醒')
      return
    }
    await ctx.reply(`⏰ *提醒列表*\n${userReminders.join('\n')}`, { parse_mode: 'Markdown' })
    return
  }

  // /remind clear
  if (args === 'clear') {
    let cleared = 0
    for (const [id, r] of reminders) {
      if (r.chatId === chatId) {
        clearTimeout(r.timer)
        reminders.delete(id)
        cleared++
      }
    }
    await ctx.reply(`🗑️ 已清除 ${cleared} 個提醒`)
    return
  }

  // /remind 5m 喝水
  const timeMatch = args.match(/^([\d]+[smh][\d]*[smh]?[\d]*[smh]?)\s+(.+)$/i)
  if (!timeMatch) {
    await ctx.reply(
      '⏰ *提醒用法*\n'
      + '`/remind 5m 喝水` — 5分鐘後提醒\n'
      + '`/remind 1h30m 開會` — 1.5小時後\n'
      + '`/remind list` — 查看提醒\n'
      + '`/remind clear` — 清除全部',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const parsed = parseTime(timeMatch[1])
  if (!parsed) {
    await ctx.reply('❌ 無效的時間格式，支援 s/m/h (例: 5m, 1h30m)')
    return
  }

  const text = timeMatch[2].trim()
  const id = `r${Date.now()}`

  const timer = setTimeout(async () => {
    reminders.delete(id)
    if (sendFn) {
      await sendFn(chatId, `⏰ *提醒！*\n${text}`).catch(() => {})
    }
  }, parsed.ms)

  reminders.set(id, {
    chatId,
    text,
    fireAt: Date.now() + parsed.ms,
    timer,
  })

  await ctx.reply(`✅ 已設定提醒：${parsed.label}後\n📝 ${text}`)
}

const reminderPlugin: Plugin = {
  name: 'reminder',
  description: '定時提醒',
  commands: [
    {
      name: 'remind',
      description: '設定提醒 (5m/1h/list/clear)',
      handler: reminderCommand,
    },
  ],
  cleanup: async () => {
    for (const [, r] of reminders) {
      clearTimeout(r.timer)
    }
    reminders.clear()
  },
}

export default reminderPlugin
