import { Markup } from 'telegraf'
import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import {
  addTask,
  getTodayTasks,
  getAllPendingTasks,
  toggleTask,
  removeTask,
  clearTodayTasks,
  markNotified,
  markTaskDoneById,
  extendTask,
} from './task-store.js'

type SendFn = (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>
let sendFn: SendFn | null = null

export function setTaskSendFn(fn: SendFn): void {
  sendFn = fn
}

let schedulerInterval: NodeJS.Timeout | null = null

// --- Time parsing ---

function parseTimeRange(input: string): { start: string; end?: string } | null {
  // "09:00-10:30" or "09:00"
  const rangeMatch = input.match(/^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/)
  if (rangeMatch) {
    return {
      start: normalizeTime(rangeMatch[1]),
      end: normalizeTime(rangeMatch[2]),
    }
  }

  const singleMatch = input.match(/^(\d{1,2}:\d{2})$/)
  if (singleMatch) {
    return { start: normalizeTime(singleMatch[1]) }
  }

  return null
}

function normalizeTime(t: string): string {
  const [h, m] = t.split(':')
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function currentHHMM(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

// --- Display ---

function buildTaskList(chatId: number): string {
  const tasks = getTodayTasks(chatId)
  const now = new Date()
  const dateLabel = `${now.getMonth() + 1}/${now.getDate()}`
  const currentTime = currentHHMM()

  if (tasks.length === 0) {
    return `📋 *今日任務* (${dateLabel})\n\n還沒有任務，用 \`/task add HH:MM 任務名\` 新增`
  }

  // Sort by startTime
  const sorted = [...tasks].sort((a, b) => a.startTime.localeCompare(b.startTime))

  const lines = [`📋 *今日任務* (${dateLabel})`, '']

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    const timeStr = t.endTime ? `${t.startTime}-${t.endTime}` : t.startTime

    let icon: string
    if (t.done) {
      icon = '✅'
    } else if (isCurrentTask(t, currentTime)) {
      icon = '🔔'
    } else if (t.startTime <= currentTime) {
      icon = '⏰'
    } else {
      icon = '⬜'
    }

    const pad = timeStr.length < 11 ? ' '.repeat(11 - timeStr.length) : ''
    lines.push(`\`${i + 1}.\` \`${timeStr}\`${pad} ${icon} ${t.text}`)
  }

  const doneCount = sorted.filter((t) => t.done).length
  lines.push('')
  lines.push(`完成 ${doneCount}/${sorted.length}`)

  return lines.join('\n')
}

function isCurrentTask(t: { startTime: string; endTime?: string; done: boolean }, currentTime: string): boolean {
  if (t.done) return false
  if (t.endTime) {
    return t.startTime <= currentTime && currentTime < t.endTime
  }
  return t.startTime <= currentTime
}

// --- Scheduler ---

function startTaskScheduler(): void {
  if (schedulerInterval) return

  schedulerInterval = setInterval(() => {
    checkAndNotify().catch((err) => {
      console.error('[task] scheduler error:', err)
    })
  }, 60_000)
}

function stopTaskScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
}

async function checkAndNotify(): Promise<void> {
  if (!sendFn) return

  const currentTime = currentHHMM()
  const pending = getAllPendingTasks()

  for (const task of pending) {
    // Start notification
    if (!task.notifiedStart && task.startTime === currentTime) {
      const timeLabel = task.endTime ? `${task.startTime}-${task.endTime}` : task.startTime
      await sendFn(
        task.chatId,
        `📋 *任務開始！*\n\n🕐 ${timeLabel}\n📝 ${task.text}\n\n加油！💪`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ 完成', `task:done:${task.id}`)],
          ]),
        },
      ).catch(() => {})
      markNotified(task.chatId, task.id, 'notifiedStart')
    }

    // End notification (only if endTime is set)
    if (task.endTime && !task.notifiedEnd && task.endTime === currentTime) {
      await sendFn(
        task.chatId,
        `⏰ *時間到！*\n\n📝 ${task.text}（${task.startTime}-${task.endTime}）\n\n完成了嗎？`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ 完成', `task:done:${task.id}`),
              Markup.button.callback('⏳ 再 15 分鐘', `task:extend:${task.id}`),
            ],
          ]),
        },
      ).catch(() => {})
      markNotified(task.chatId, task.id, 'notifiedEnd')
    }
  }
}

// --- Command handler ---

async function taskCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/task\s*/i, '').trim()

  // /task (no args) → show list
  if (!args) {
    await ctx.reply(buildTaskList(chatId), { parse_mode: 'Markdown' })
    return
  }

  const parts = args.split(/\s+/)
  const sub = parts[0].toLowerCase()

  // /task add 09:00 寫報告
  // /task add 09:00-10:30 寫報告
  if (sub === 'add' || sub === 'a') {
    if (parts.length < 3) {
      await ctx.reply(
        '⚠️ 用法：`/task add HH:MM 任務名`\n' +
        '或：`/task add HH:MM-HH:MM 任務名`',
        { parse_mode: 'Markdown' },
      )
      return
    }

    const timeInput = parts[1]
    const parsed = parseTimeRange(timeInput)
    if (!parsed) {
      await ctx.reply('❌ 時間格式錯誤，請用 `09:00` 或 `09:00-10:30`', { parse_mode: 'Markdown' })
      return
    }

    const text = parts.slice(2).join(' ')
    const item = addTask(chatId, text, parsed.start, parsed.end)

    const timeLabel = item.endTime ? `${item.startTime}-${item.endTime}` : item.startTime

    // Start scheduler if not running
    startTaskScheduler()

    await ctx.reply(
      `✅ 已新增任務\n\n🕐 *${timeLabel}* — ${text}`,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // /task done 2
  if (sub === 'done' || sub === 'd') {
    const num = parseInt(parts[1], 10)
    if (isNaN(num) || num < 1) {
      await ctx.reply('⚠️ 用法：`/task done <編號>`', { parse_mode: 'Markdown' })
      return
    }

    const toggled = toggleTask(chatId, num - 1)
    if (!toggled) {
      await ctx.reply('❌ 找不到該任務')
      return
    }

    const status = toggled.done ? '✅ 已完成' : '⬜ 未完成'
    await ctx.reply(`${status}：${toggled.text}`)
    return
  }

  // /task remove 2
  if (sub === 'remove' || sub === 'rm' || sub === 'del') {
    const num = parseInt(parts[1], 10)
    if (isNaN(num) || num < 1) {
      await ctx.reply('⚠️ 用法：`/task remove <編號>`', { parse_mode: 'Markdown' })
      return
    }

    const removed = removeTask(chatId, num - 1)
    if (!removed) {
      await ctx.reply('❌ 找不到該任務')
      return
    }

    await ctx.reply(`🗑️ 已刪除：${removed.text}`)
    return
  }

  // /task clear
  if (sub === 'clear') {
    const count = clearTodayTasks(chatId)
    await ctx.reply(count > 0 ? `🗑️ 已清除 ${count} 個任務` : '📋 今天沒有任務')
    return
  }

  // /task help
  await ctx.reply(
    '📋 *任務排程*\n\n' +
    '`/task` — 查看今日任務\n' +
    '`/task add 09:00 寫報告` — 新增\n' +
    '`/task add 09:00-10:30 開會` — 含結束時間\n' +
    '`/task done 2` — 標記完成/未完成\n' +
    '`/task remove 2` — 刪除任務\n' +
    '`/task clear` — 清除今日全部',
    { parse_mode: 'Markdown' },
  )
}

// --- Callback handler ---

async function handleCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('task:')) return false

  const chatId = ctx.chat?.id
  if (!chatId) return true

  // task:done:{id}
  if (data.startsWith('task:done:')) {
    const taskId = data.replace('task:done:', '')
    markTaskDoneById(chatId, taskId)
    await ctx.editMessageText('✅ 已標記完成！做得好 👍').catch(() => {})
    await ctx.answerCbQuery('✅ 完成')
    return true
  }

  // task:extend:{id}
  if (data.startsWith('task:extend:')) {
    const taskId = data.replace('task:extend:', '')
    const extended = extendTask(chatId, taskId, 15)
    if (extended) {
      await ctx.editMessageText(
        `⏳ 已延長 15 分鐘\n新結束時間：*${extended.endTime}*`,
        { parse_mode: 'Markdown' },
      ).catch(() => {})
      await ctx.answerCbQuery('⏳ +15 分鐘')
    } else {
      await ctx.answerCbQuery('❌ 無法延長')
    }
    return true
  }

  return false
}

// --- Plugin export ---

const taskPlugin: Plugin = {
  name: 'task',
  description: '每日任務排程 + 時間提醒',
  commands: [
    {
      name: 'task',
      description: '管理每日任務排程',
      handler: taskCommand,
    },
  ],
  onCallback: handleCallback,
  cleanup: async () => {
    stopTaskScheduler()
  },
  service: {
    start: async () => {
      startTaskScheduler()
    },
    stop: async () => {
      stopTaskScheduler()
    },
  },
}

export default taskPlugin
