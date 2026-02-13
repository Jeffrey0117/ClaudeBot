import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { QueueItem } from '../types/index.js'
import { setProcessor } from '../claude/queue.js'
import { runClaude, cancelRunning } from '../claude/claude-runner.js'
import { cleanupImage } from '../utils/image-downloader.js'
import { splitText } from '../utils/text-splitter.js'

const TIMEOUT_MS = 30 * 60 * 1000

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    const tag = item.project.name

    // Status message: only shows processing progress, never the response text
    const statusMsg = await telegram.sendMessage(
      item.chatId,
      `\u{1F680} *[${tag}]* Processing...\n_Model: ${item.model}_`,
      { parse_mode: 'Markdown' }
    )

    return new Promise<void>((resolve) => {
      let resolved = false
      let accumulated = ''
      let toolCount = 0
      const toolNames: string[] = []
      const startTime = Date.now()

      const typingInterval = setInterval(() => {
        telegram.sendChatAction(item.chatId, 'typing').catch(() => {})
      }, 5000)
      telegram.sendChatAction(item.chatId, 'typing').catch(() => {})

      const cleanupImages = () => {
        for (const imagePath of item.imagePaths) {
          cleanupImage(imagePath)
        }
      }

      const done = () => {
        if (resolved) return
        resolved = true
        clearInterval(typingInterval)
        clearInterval(tickInterval)
        cleanupImages()
        resolve()
      }

      const timer = setTimeout(() => {
        if (resolved) return
        cancelRunning(item.project.path)
        telegram.editMessageText(
          item.chatId, statusMsg.message_id, undefined,
          `\u{23F0} *[${tag}]* Timeout (30 min)`,
          { parse_mode: 'Markdown' }
        ).catch(() => {})
        done()
      }, TIMEOUT_MS)

      // Update status message with elapsed time + tool progress
      let lastStatusText = ''
      const updateStatus = (): void => {
        if (resolved) return
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const toolInfo = toolCount > 0
          ? `\n\u{1F527} Tools: ${toolCount} (${[...new Set(toolNames)].slice(-4).join(', ')})`
          : ''
        const status = `\u{1F680} *[${tag}]* ${elapsed}s${toolInfo}`
        if (status === lastStatusText) return
        lastStatusText = status
        telegram.editMessageText(
          item.chatId, statusMsg.message_id, undefined,
          status, { parse_mode: 'Markdown' }
        ).catch(() => {})
      }

      // Tick every second for live elapsed time
      const tickInterval = setInterval(updateStatus, 1000)

      runClaude({
        prompt: item.prompt,
        projectPath: item.project.path,
        model: item.model,
        sessionId: item.sessionId,
        imagePaths: item.imagePaths,
        onTextDelta: (_delta, acc) => {
          accumulated = acc
          // Don't edit status msg with text — text goes to new messages at the end
        },
        onToolUse: (toolName) => {
          toolCount++
          toolNames.push(toolName)
          updateStatus()
        },
        onResult: (result) => {
          if (resolved) return
          clearTimeout(timer)
          try {
            const cost = (result.costUsd ?? 0).toFixed(4)
            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
            const toolSummary = toolCount > 0
              ? ` | \u{1F527} ${toolCount} tools`
              : ''

            // Update status to "Done" summary
            telegram.editMessageText(
              item.chatId, statusMsg.message_id, undefined,
              `\u{2705} *[${tag}]* Done | $${cost} | ${totalTime}s${toolSummary}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {})

            // Send response text as new message(s)
            const responseText = result.resultText || accumulated || ''
            if (!responseText) {
              done()
              return
            }

            const chunks = splitText(responseText, 4096)
            let chain = Promise.resolve()
            for (const chunk of chunks) {
              chain = chain.then(() =>
                telegram.sendMessage(item.chatId, chunk).then(() => {})
              )
            }
            chain.then(() => done()).catch(() => done())
          } catch (err) {
            console.error('[queue] onResult error:', err)
            done()
          }
        },
        onError: (error) => {
          if (resolved) return
          clearTimeout(timer)
          telegram.editMessageText(
            item.chatId, statusMsg.message_id, undefined,
            `\u{274C} *[${tag}]* Error\n\n\`${error}\``,
            { parse_mode: 'Markdown' }
          )
            .then(() => done())
            .catch(() => {
              telegram.editMessageText(
                item.chatId, statusMsg.message_id, undefined,
                `Error: ${error}`
              )
                .then(() => done())
                .catch(() => done())
            })
        },
      })
    })
  })
}
