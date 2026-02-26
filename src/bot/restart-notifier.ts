/**
 * After bot restarts, notify users who had an active project
 * with a "Continue?" inline button so they can resume seamlessly.
 */

import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { getActiveUserStates } from './state.js'
import { Markup } from 'telegraf'
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
        `\u{1F504} Bot \u{5DF2}\u{91CD}\u{555F}\u{3002}\u{7E7C}\u{7E8C} *${project}* \uFF1F\n_${ai}_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('\u{2705} \u{7E7C}\u{7E8C}', 'resume:yes'),
            Markup.button.callback('\u{274C} \u{4E0D}\u{7528}', 'resume:no'),
          ]),
        },
      ).catch(() => {})
    }
  }, NOTIFY_DELAY_MS)
}
