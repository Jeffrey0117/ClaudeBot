import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { QueueItem } from '../types/index.js'
import { setProcessor } from '../claude/queue.js'
import { runClaude, cancelRunning } from '../claude/claude-runner.js'
import { cleanupImage } from '../utils/image-downloader.js'
import { updateStreamMessage, cancelPendingEdit } from '../telegram/message-sender.js'
import { splitText } from '../utils/text-splitter.js'

const TIMEOUT_MS = 30 * 60 * 1000

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    const tag = item.project.name

    const thinkingMsg = await telegram.sendMessage(
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
        cleanupImages()
        resolve()
      }

      const timer = setTimeout(() => {
        if (resolved) return
        cancelRunning(item.project.path)
        cancelPendingEdit(item.chatId, thinkingMsg.message_id)
        telegram.editMessageText(
          item.chatId,
          thinkingMsg.message_id,
          undefined,
          `\u{23F0} *[${tag}]* Timeout (30 min)\nUse /cancel if stuck.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {})
        done()
      }, TIMEOUT_MS)

      const buildHeader = (): string => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const toolInfo = toolCount > 0
          ? `\n\u{1F527} Tools: ${toolCount} (${[...new Set(toolNames)].slice(-3).join(', ')})`
          : ''
        return `\u{1F4AC} *[${tag}]* _${elapsed}s_${toolInfo}\n\n`
      }

      runClaude({
        prompt: item.prompt,
        projectPath: item.project.path,
        model: item.model,
        sessionId: item.sessionId,
        imagePaths: item.imagePaths,
        onTextDelta: (_delta, acc) => {
          accumulated = acc
          const display = buildHeader() + acc
          updateStreamMessage(item.chatId, thinkingMsg.message_id, display, telegram)
        },
        onToolUse: (toolName) => {
          toolCount++
          toolNames.push(toolName)
          const display = buildHeader() + (accumulated || '_waiting for response..._')
          updateStreamMessage(item.chatId, thinkingMsg.message_id, display, telegram)
        },
        onResult: (result) => {
          if (resolved) return
          clearTimeout(timer)
          cancelPendingEdit(item.chatId, thinkingMsg.message_id)
          try {
            const cost = (result.costUsd ?? 0).toFixed(4)
            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
            const toolSummary = toolCount > 0
              ? ` | Tools: ${toolCount}`
              : ''
            const footer = `\u{2500}\u{2500}\u{2500}\n\u{2705} *[${tag}]* $${cost} | ${totalTime}s${toolSummary}`

            const responseText = result.resultText || accumulated || ''
            const fullText = responseText
              ? responseText + '\n\n' + footer
              : footer

            // Delete the streaming/thinking message, send result as new message(s)
            telegram.deleteMessage(item.chatId, thinkingMsg.message_id).catch(() => {})

            const chunks = splitText(fullText, 4096)
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
          cancelPendingEdit(item.chatId, thinkingMsg.message_id)
          telegram.editMessageText(
            item.chatId,
            thinkingMsg.message_id,
            undefined,
            `\u{274C} *[${tag}]* Error\n\n\`${error}\``,
            { parse_mode: 'Markdown' }
          )
            .then(() => done())
            .catch(() => {
              telegram.editMessageText(item.chatId, thinkingMsg.message_id, undefined, `Error: ${error}`)
                .then(() => done())
                .catch(() => done())
            })
        },
      })
    })
  })
}
