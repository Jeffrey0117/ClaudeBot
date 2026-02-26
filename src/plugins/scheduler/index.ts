import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// --- Persistent storage ---

const DATA_PATH = resolve('data/schedules.json')

interface ScheduledTask {
  readonly id: string
  readonly chatId: number
  readonly time: string // "09:00" format
  readonly type: 'bitcoin-price' | 'custom'
  readonly enabled: boolean
}

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadTasks(): Map<string, ScheduledTask> {
  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    const arr = JSON.parse(raw) as ScheduledTask[]
    const map = new Map<string, ScheduledTask>()
    for (const task of arr) {
      map.set(task.id, task)
    }
    return map
  } catch {
    return new Map()
  }
}

function saveTasks(map: Map<string, ScheduledTask>): void {
  ensureDir()
  const arr = [...map.values()]
  writeFileSync(DATA_PATH, JSON.stringify(arr, null, 2), 'utf-8')
}

const tasks: Map<string, ScheduledTask> = new Map()
let schedulerInterval: NodeJS.Timeout | null = null

// Callback to send Telegram messages (injected from bot.ts)
let sendMessage: ((chatId: number, text: string, extra?: { parse_mode?: 'Markdown' }) => Promise<void>) | null = null

export function setSchedulerSendFn(fn: typeof sendMessage): void {
  sendMessage = fn
}

// --- Task implementations ---

async function fetchBitcoinPrice(): Promise<string> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,twd', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`API ${res.status}`)

    const data = await res.json() as { bitcoin?: { usd?: number; twd?: number } }
    const usd = data.bitcoin?.usd
    const twd = data.bitcoin?.twd

    if (!usd || !twd) throw new Error('Missing price data')

    const lines = [
      '\u20bf *Bitcoin \u50f9\u683c*',
      '',
      `\ud83d\udcb5 *USD:* $${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `\ud83d\udcb0 *TWD:* NT$${twd.toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      '',
      `_${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}_`,
    ]

    return lines.join('\n')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return `\u274c \u7121\u6cd5\u53d6\u5f97\u6bd4\u7279\u5e63\u50f9\u683c: ${msg}`
  }
}

async function executeTask(task: ScheduledTask): Promise<void> {
  if (!sendMessage) return

  switch (task.type) {
    case 'bitcoin-price': {
      const message = await fetchBitcoinPrice()
      await sendMessage(task.chatId, message, { parse_mode: 'Markdown' })
      break
    }
    default:
      break
  }
}

// --- Scheduler loop ---

function startScheduler(): void {
  if (schedulerInterval) return

  schedulerInterval = setInterval(() => {
    const now = new Date()
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

    for (const task of tasks.values()) {
      if (task.enabled && task.time === currentTime) {
        executeTask(task).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[scheduler] Task execution failed: ${msg}`)
        })
      }
    }
  }, 60_000)
}

function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
}

// --- Commands ---

async function scheduleCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = text.replace(/^\/schedule\s*/i, '').trim()

  if (!args) {
    const userTasks = [...tasks.values()].filter((t) => t.chatId === chatId)

    if (userTasks.length === 0) {
      await ctx.reply(
        '\ud83d\udcc5 *\u6392\u7a0b\u4efb\u52d9*\n\n' +
        '\u76ee\u524d\u6c92\u6709\u6392\u7a0b\u4efb\u52d9\n\n' +
        '*\u7528\u6cd5:*\n' +
        '`/schedule bitcoin 09:00` \u2014 \u6bcf\u5929 9 \u9ede\u63a8\u64ad\u6bd4\u7279\u5e63\u50f9\u683c\n' +
        '`/schedule list` \u2014 \u5217\u51fa\u6240\u6709\u4efb\u52d9\n' +
        '`/schedule remove <id>` \u2014 \u79fb\u9664\u4efb\u52d9',
        { parse_mode: 'Markdown' },
      )
      return
    }

    const lines = ['\ud83d\udcc5 *\u4f60\u7684\u6392\u7a0b\u4efb\u52d9*', '']
    for (const task of userTasks) {
      const status = task.enabled ? '\u2705' : '\u274c'
      const typeLabel = task.type === 'bitcoin-price' ? '\u20bf Bitcoin \u50f9\u683c' : task.type
      lines.push(`${status} \`${task.id}\` \u2014 ${typeLabel} @ ${task.time}`)
    }
    lines.push('')
    lines.push('\u7528 `/schedule remove <id>` \u79fb\u9664\u4efb\u52d9')

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
    return
  }

  const parts = args.split(/\s+/)
  const subcommand = parts[0].toLowerCase()

  if (subcommand === 'list') {
    return scheduleCommand(ctx)
  }

  if (subcommand === 'remove' || subcommand === 'delete') {
    const id = parts[1]
    if (!id) {
      await ctx.reply('\u26a0\ufe0f \u8acb\u6307\u5b9a\u4efb\u52d9 ID\n\n\u7528\u6cd5: `/schedule remove <id>`', { parse_mode: 'Markdown' })
      return
    }

    const task = tasks.get(id)
    if (!task || task.chatId !== chatId) {
      await ctx.reply(`\u274c \u627e\u4e0d\u5230\u4efb\u52d9 \`${id}\``, { parse_mode: 'Markdown' })
      return
    }

    tasks.delete(id)
    saveTasks(tasks)
    await ctx.reply(`\u2705 \u5df2\u79fb\u9664\u4efb\u52d9 \`${id}\``, { parse_mode: 'Markdown' })
    return
  }

  if (subcommand === 'bitcoin') {
    const time = parts[1]
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
      await ctx.reply(
        '\u26a0\ufe0f \u6642\u9593\u683c\u5f0f\u932f\u8aa4\n\n' +
        '\u7528\u6cd5: `/schedule bitcoin 09:00`\n' +
        '\u6642\u9593\u683c\u5f0f: `HH:MM` (24 \u5c0f\u6642\u5236)',
        { parse_mode: 'Markdown' },
      )
      return
    }

    const [h, m] = time.split(':')
    const normalizedTime = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`

    const id = `btc-${chatId}-${Date.now()}`
    const task: ScheduledTask = {
      id,
      chatId,
      time: normalizedTime,
      type: 'bitcoin-price',
      enabled: true,
    }

    tasks.set(id, task)
    saveTasks(tasks)
    startScheduler()

    await ctx.reply(
      `\u2705 \u5df2\u8a2d\u5b9a\u6392\u7a0b\u4efb\u52d9\n\n` +
      `\u20bf \u6bcf\u5929 *${normalizedTime}* \u63a8\u64ad\u6bd4\u7279\u5e63\u50f9\u683c\n\n` +
      `\u4efb\u52d9 ID: \`${id}\``,
      { parse_mode: 'Markdown' },
    )
    return
  }

  await ctx.reply(
    '\u26a0\ufe0f \u672a\u77e5\u6307\u4ee4\n\n' +
    '*\u53ef\u7528\u6307\u4ee4:*\n' +
    '`/schedule bitcoin 09:00` \u2014 \u8a2d\u5b9a\u6bd4\u7279\u5e63\u50f9\u683c\u63a8\u64ad\n' +
    '`/schedule list` \u2014 \u5217\u51fa\u4efb\u52d9\n' +
    '`/schedule remove <id>` \u2014 \u79fb\u9664\u4efb\u52d9',
    { parse_mode: 'Markdown' },
  )
}

// --- Service lifecycle ---

async function start(): Promise<void> {
  // Load persisted tasks on startup
  const loaded = loadTasks()
  for (const [id, task] of loaded) {
    tasks.set(id, task)
  }

  if (tasks.size > 0) {
    startScheduler()
  }
}

async function stop(): Promise<void> {
  stopScheduler()
}

// --- Cleanup (uninstall) ---

async function cleanup(): Promise<void> {
  stopScheduler()
  tasks.clear()

  // Delete persisted data on uninstall
  try {
    if (existsSync(DATA_PATH)) {
      unlinkSync(DATA_PATH)
    }
  } catch {
    // ignore
  }
}

// --- Plugin export ---

const schedulerPlugin: Plugin = {
  name: 'scheduler',
  description: '\u5b9a\u6642\u4efb\u52d9\u6392\u7a0b',
  commands: [
    {
      name: 'schedule',
      description: '\u7ba1\u7406\u5b9a\u6642\u4efb\u52d9\uff08\u6bd4\u7279\u5e63\u50f9\u683c\u7b49\uff09',
      handler: scheduleCommand,
    },
  ],
  service: { start, stop },
  cleanup,
}

export default schedulerPlugin
