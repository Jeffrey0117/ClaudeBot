/**
 * After bot restarts, notify users who had an active project
 * or an active remote pairing so they can resume seamlessly.
 */

import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { getActiveUserStates } from './state.js'
import { formatAILabel } from '../ai/types.js'
import { getAllConnectedPairings } from '../remote/pairing-store.js'
import { env } from '../config/env.js'

const NOTIFY_DELAY_MS = 3_000

function deriveBotLabel(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'Bot'
  // .env.bot5 → "Bot [5]"
  const num = envArg.replace(/^\.env\.bot/, '')
  return `Bot [${num}]`
}

export function scheduleRestartNotifications(bot: Telegraf<BotContext>): void {
  setTimeout(() => {
    const label = deriveBotLabel()
    const notifiedChats = new Set<number>()

    // 1) Notify users with an active local project (with context)
    const states = getActiveUserStates()
    for (const [key, state] of states) {
      if (!state.selectedProject) continue

      const chatId = parseInt(key.split(':')[0], 10)
      if (isNaN(chatId) || chatId === 0) continue

      notifiedChats.add(chatId)
      const project = state.selectedProject.name
      const ai = formatAILabel(state.ai)

      bot.telegram.sendMessage(
        chatId,
        `🔄 ${label} 已重啟，已自動帶入 *${project}*\n_${ai}_`,
        { parse_mode: 'Markdown' },
      ).catch((err) => {
        console.error(`[restart-notify] Failed to notify ${chatId}:`, err.message)
      })
    }

    // 2) For REMOTE_ENABLED bots, also notify users with active pairings
    if (env.REMOTE_ENABLED) {
      const pairings = getAllConnectedPairings()
      for (const pairing of pairings) {
        if (notifiedChats.has(pairing.chatId)) continue
        notifiedChats.add(pairing.chatId)

        bot.telegram.sendMessage(
          pairing.chatId,
          `🔄 ${label} 已重啟，遠端配對等待自動重連…`,
          { parse_mode: 'Markdown' },
        ).catch((err) => {
          console.error(`[restart-notify] Failed to notify pairing ${pairing.chatId}:`, err.message)
        })
      }
    }

    // 3) Always notify all ALLOWED_CHAT_IDS that haven't been notified yet
    //    Ensures new bots, chat-mode users, and pair-mode users all get notified
    for (const chatId of env.ALLOWED_CHAT_IDS) {
      if (notifiedChats.has(chatId)) continue
      notifiedChats.add(chatId)

      bot.telegram.sendMessage(
        chatId,
        `🔄 ${label} 已重啟，待命中`,
        { parse_mode: 'Markdown' },
      ).catch((err) => {
        console.error(`[restart-notify] Failed to notify ${chatId}:`, err.message)
      })
    }
  }, NOTIFY_DELAY_MS)
}
