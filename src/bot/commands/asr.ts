import type { BotContext } from '../../types/context.js'
import { getAsrMode, setAsrMode } from '../asr-store.js'

export async function asrCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const arg = text.replace(/^\/asr\s*/, '').trim().toLowerCase()

  if (arg === 'on') {
    setAsrMode(chatId, 'on')
    await ctx.reply('🎙 ASR 連續模式已開啟（5 分鐘自動關閉）\n語音訊息將只轉文字，不送 AI。\n`/asr off` 手動關閉。', { parse_mode: 'Markdown' })
    return
  }

  if (arg === 'off') {
    setAsrMode(chatId, 'off')
    await ctx.reply('🎙 ASR 模式已關閉，語音恢復送 AI 處理。')
    return
  }

  // No arg or anything else → one-shot mode
  const current = getAsrMode(chatId)
  if (current !== 'off') {
    // Already in ASR mode, show status
    const modeLabel = current === 'on' ? '連續模式' : '單次模式'
    await ctx.reply(`🎙 ASR 目前：${modeLabel}\n\`/asr off\` 關閉`, { parse_mode: 'Markdown' })
    return
  }

  setAsrMode(chatId, 'next')
  await ctx.reply('🎙 下一則語音將純轉文字（不送 AI）。')
}
