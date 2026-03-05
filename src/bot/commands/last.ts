/**
 * /last — Re-send a recent message.
 *
 * Usage:
 *   /last    — show last message, ask to confirm re-send
 *   /last1   — same as /last
 *   /last2   — show 2nd most recent message
 *   /last3   — show 3rd most recent message
 */

import { Markup } from 'telegraf'
import type { BotContext } from '../../types/context.js'
import { getRecentMessage } from '../last-message-store.js'

/** Pending confirmations: chatId → message text to re-send */
export const pendingResends = new Map<number, string>()

export async function lastCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  const match = raw.match(/^\/last(\d)?/i)
  const index = match?.[1] ? parseInt(match[1], 10) : 1

  if (index < 1 || index > 5) {
    await ctx.reply('用法: `/last` `/last2` `/last3` (最多 5)', { parse_mode: 'Markdown' })
    return
  }

  const message = getRecentMessage(chatId, index)
  if (!message) {
    await ctx.reply(`沒有找到第 ${index} 條歷史訊息`)
    return
  }

  // Store for callback confirmation
  pendingResends.set(chatId, message)

  // Show quoted preview + confirm button
  const preview = message.length > 200 ? message.slice(0, 200) + '...' : message
  await ctx.reply(
    `📋 第 ${index} 條訊息:\n\n> ${preview.split('\n').join('\n> ')}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 重新發送', `last_resend:${chatId}`),
        Markup.button.callback('❌ 取消', `last_cancel:${chatId}`),
      ],
    ]),
  )
}
