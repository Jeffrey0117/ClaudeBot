import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { QueueItem } from '../types/index.js'
import { setProcessor } from '../claude/queue.js'
import { runClaude } from '../claude/claude-runner.js'
import {
  updateStreamMessage,
  finalizeMessage,
  cancelPendingEdit,
} from '../telegram/message-sender.js'

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    console.log('[queue] processing item for chat:', item.chatId, 'project:', item.project.name)

    const thinkingMsg = await telegram.sendMessage(item.chatId, '💭 Thinking...')
    const messageId = thinkingMsg.message_id

    return new Promise<void>((resolve) => {
      let lastAccumulated = ''

      runClaude({
        prompt: item.prompt,
        projectPath: item.project.path,
        model: item.model,
        sessionId: item.sessionId,
        onTextDelta: (_delta, accumulated) => {
          lastAccumulated = accumulated
          updateStreamMessage(item.chatId, messageId, accumulated, telegram)
        },
        onToolUse: (toolName) => {
          telegram.sendMessage(item.chatId, `🔧 Using: ${toolName}`).catch(() => {})
        },
        onResult: (result) => {
          const footer =
            `---\n` +
            `✅ Done | Cost: $${result.costUsd.toFixed(4)} | ` +
            `Time: ${(result.durationMs / 1000).toFixed(1)}s`
          finalizeMessage(item.chatId, messageId, lastAccumulated, footer, telegram)
            .then(() => resolve())
            .catch(() => resolve())
        },
        onError: (error) => {
          cancelPendingEdit(item.chatId, messageId)
          telegram
            .sendMessage(item.chatId, `❌ Error: ${error}`)
            .then(() => resolve())
            .catch(() => resolve())
        },
      })
    })
  })
}
