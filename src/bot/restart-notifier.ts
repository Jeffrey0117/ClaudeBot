/**
 * After bot restarts, notify users who had an active project
 * with a "Continue?" inline button so they can resume seamlessly.
 */

import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { getActiveUserStates } from './state.js'
import { formatAILabel } from '../ai/types.js'

const NOTIFY_DELAY_MS = 3_000

export function scheduleRestartNotifications(bot: Telegraf<BotContext>): void {
  setTimeout(() => {
    const states = getActiveUserStates()

    for (const [key, state] of states) {
      if (!state.selectedProject) continue

      // key format: "chatId" or "chatId:threadId"
      const chatId = parseInt(key.split(':')[0], 10)
      if (isNaN(chatId) || chatId === 0) continue

      const project = state.selectedProject.name
      const ai = formatAILabel(state.ai)

      bot.telegram.sendMessage(
        chatId,
        `\u{1F504} Bot \u{5DF2}\u{91CD}\u{555F}\uFF0C\u{5DF2}\u{81EA}\u{52D5}\u{5E36}\u{5165} *${project}*\n_${ai}_`,
        { parse_mode: 'Markdown' },
      ).catch(() => {})
    }
  }, NOTIFY_DELAY_MS)
}
