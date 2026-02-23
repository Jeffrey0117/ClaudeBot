import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { QueueItem } from '../types/index.js'
import { setProcessor, enqueue } from '../claude/queue.js'
import { runClaude, cancelRunning } from '../claude/claude-runner.js'
import { existsSync } from 'node:fs'
import { Input } from 'telegraf'
import { cleanupImage } from '../utils/image-downloader.js'
import { splitText } from '../utils/text-splitter.js'
import { detectImagePaths } from '../utils/image-detector.js'
import { parseCrossProjectTasks } from '../utils/cross-project-parser.js'
import { getSessionId } from '../claude/session-store.js'

const TIMEOUT_MS = 30 * 60 * 1000

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    const tag = item.project.name

    // Status message: only shows processing progress, never the response text
    const statusMsg = await telegram.sendMessage(
      item.chatId,
      `\u{1F680} *[${tag}]* \u{8655}\u{7406}\u{4E2D}...\n_\u{6A21}\u{578B}: ${item.model}_`,
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
          `\u{23F0} *[${tag}]* \u{903E}\u{6642} (30 \u{5206}\u{9418})`,
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
              `\u{2705} *[${tag}]* \u{5B8C}\u{6210} | $${cost} | ${totalTime}\u{79D2}${toolSummary}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {})

            // Detect and send any image files mentioned in the response
            const responseText = result.resultText || accumulated || ''
            const detectedImages = detectImagePaths(responseText)
            const validImages = detectedImages.filter((p) => existsSync(p))

            let imageChain = Promise.resolve()
            for (const imgPath of validImages) {
              imageChain = imageChain.then(() =>
                telegram.sendPhoto(item.chatId, Input.fromLocalFile(imgPath), {
                  caption: imgPath,
                }).then(() => {})
              ).catch((err) => {
                console.error('[queue] sendPhoto error:', err)
              })
            }

            // After images, send text response, then check for cross-project tasks
            imageChain.then(() => {
              if (!responseText) {
                dispatchCrossProjectTasks(telegram, item, responseText)
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
              chain.then(() => {
                dispatchCrossProjectTasks(telegram, item, responseText)
                done()
              }).catch(() => done())
            }).catch(() => done())
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
            `\u{274C} *[${tag}]* \u{932F}\u{8AA4}\n\n\`${error}\``,
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

function dispatchCrossProjectTasks(
  telegram: Telegraf<BotContext>['telegram'],
  sourceItem: QueueItem,
  responseText: string
): void {
  const tasks = parseCrossProjectTasks(responseText)
  if (tasks.length === 0) return

  for (const task of tasks) {
    // Don't delegate to the same project
    if (task.project.path === sourceItem.project.path) continue

    const sessionId = getSessionId(task.project.path)

    enqueue({
      chatId: sourceItem.chatId,
      prompt: task.prompt,
      project: task.project,
      model: sourceItem.model,
      sessionId,
      imagePaths: [],
    })

    telegram.sendMessage(
      sourceItem.chatId,
      `\u{1F916} *[${sourceItem.project.name}]* \u{81EA}\u{52D5}\u{59D4}\u{6D3E}\u{8DE8}\u{5C08}\u{6848}\u{4EFB}\u{52D9}\n\u{27A1}\u{FE0F} [${task.project.name}] ${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? '...' : ''}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {})
  }
}
