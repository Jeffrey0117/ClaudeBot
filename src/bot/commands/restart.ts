import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotContext } from '../../types/context.js'
import { isProcessing, getQueueLength } from '../../claude/queue.js'
import { getBotInstance } from '../bot.js'

// Exit code 42 = intentional restart (distinguished from crashes in launcher)
const RESTART_EXIT_CODE = 42
// Signal file: launcher restarts EVERY bot gracefully (each waits until idle)
const RESTART_GRACEFUL_SIGNAL = join(process.cwd(), 'data', '.restart-graceful')

// True once a graceful (drain-then-restart) is armed for THIS bot.
let pendingGracefulRestart = false

async function gracefulRestart(): Promise<void> {
  const bot = getBotInstance()
  // Stop Telegraf polling first so Telegram releases the session immediately.
  // Without this, the respawned bot hits 409 Conflict for up to 30s.
  if (bot) {
    try {
      bot.stop('restart')
    } catch {
      // Best-effort — proceed with exit even if stop fails
    }
  }
  // Small delay to let the stop signal propagate
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 500)
}

/** Restart THIS bot only once it finishes its current task + drains its queue,
 *  so the in-flight work isn't interrupted. Polls until idle, then restarts. */
function scheduleGracefulRestart(): void {
  if (pendingGracefulRestart) return
  pendingGracefulRestart = true
  const timer = setInterval(() => {
    if (!isProcessing() && getQueueLength() === 0) {
      clearInterval(timer)
      void gracefulRestart()
    }
  }, 3000)
  timer.unref?.()
}

/** Tell the launcher to restart ALL bots gracefully — each one waits until it
 *  is idle before restarting, so busy bots are never interrupted. */
function signalRestartGraceful(): void {
  try {
    writeFileSync(RESTART_GRACEFUL_SIGNAL, String(Date.now()), 'utf-8')
  } catch {
    // Best-effort
  }
}

export async function restartCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const arg = raw.replace(/^\/restart(@\S+)?\s*/, '').trim().toLowerCase()

  // /restart all → every bot restarts when it goes idle (no interruption).
  // This bot does NOT exit itself — the launcher drains + restarts everyone.
  if (arg === 'all') {
    await ctx.reply('🔄 已通知所有 Bot：各自跑完手上任務後自動重啟（忙碌中的不會被打斷）')
    signalRestartGraceful()
    return
  }

  if (isProcessing()) {
    await ctx.reply('⚠️ 有任務正在執行中，要怎麼重啟？', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏳ 跑完再重啟（推薦）', callback_data: 'restart:graceful' }],
          [
            { text: '✅ 強制重啟', callback_data: 'restart:force' },
            { text: '❌ 取消', callback_data: 'restart:cancel' },
          ],
        ],
      },
    })
    return
  }

  await ctx.reply('🔄 重啟中...\n💡 _用 `/restart all` 可重啟所有 Bot_', { parse_mode: 'Markdown' })
  await gracefulRestart()
}

export async function handleRestartCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('restart:')) return false

  if (data === 'restart:force') {
    await ctx.editMessageText('🔄 強制重啟中...').catch(() => {})
    await ctx.answerCbQuery()
    await gracefulRestart()
  } else if (data === 'restart:graceful') {
    await ctx.editMessageText('⏳ 好，等手上任務跑完就自動重啟（你不用顧）').catch(() => {})
    await ctx.answerCbQuery()
    scheduleGracefulRestart()
  } else if (data === 'restart:cancel') {
    await ctx.editMessageText('❌ 已取消重啟').catch(() => {})
    await ctx.answerCbQuery()
  }

  return true
}
