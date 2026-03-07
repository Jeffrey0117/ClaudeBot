import type { BotContext } from '../../types/context.js'
import { getStreamMode, setStreamMode } from '../state.js'

export async function streamCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.replace(/^\/stream\s*/, '').trim().toLowerCase()
  const threadId = ctx.message?.message_thread_id

  if (args === 'on') {
    setStreamMode(chatId, true, threadId)
    await ctx.reply('已開啟串流模式 — 文字會逐步顯示')
    return
  }

  if (args === 'off') {
    setStreamMode(chatId, false, threadId)
    await ctx.reply('已關閉串流模式 — 完成後一次送出')
    return
  }

  // No args → toggle
  const current = getStreamMode(chatId, threadId)
  const next = !current
  setStreamMode(chatId, next, threadId)

  if (next) {
    await ctx.reply('已開啟串流模式 — 文字會逐步顯示')
  } else {
    await ctx.reply('已關閉串流模式 — 完成後一次送出')
  }
}
