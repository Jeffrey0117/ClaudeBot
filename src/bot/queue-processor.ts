import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { QueueItem } from '../types/index.js'
import { setProcessor, setLockNotify, enqueue } from '../claude/queue.js'
import { getRunner, cancelAnyRunning } from '../ai/registry.js'
import { existsSync } from 'node:fs'
import { Input, Markup } from 'telegraf'
import { cleanupImage } from '../utils/image-downloader.js'
import { splitText } from '../utils/text-splitter.js'
import { detectImagePaths } from '../utils/image-detector.js'
import { parseCrossProjectTasks, stripRunDirectives } from '../utils/cross-project-parser.js'
import { parseCommandDirectives, stripCommandDirectives } from '../utils/command-executor.js'
import { createFakeContext } from '../utils/fake-context.js'
import { dispatchPluginCommand, dispatchOutputHooks } from '../plugins/loader.js'
import { getRandomTidbit } from '../utils/idle-tidbits.js'
import { getAISessionId } from '../ai/session-store.js'
import { detectChoices } from '../utils/choice-detector.js'
import { cleanMarkdown } from '../utils/markdown-cleaner.js'
import { generateSuggestions } from '../utils/suggestion-generator.js'
import { setSuggestions } from './suggestion-store.js'
import { setChoices } from './choice-store.js'
import { formatAILabel } from '../ai/types.js'
import type { AIModelSelection } from '../ai/types.js'
import { autoRoute } from '../ai/router.js'
import { setActiveRunner, updateRunnerTool, removeActiveRunner } from '../dashboard/runner-tracker.js'
import { recordCost } from '../plugins/cost/index.js'
import { recordActivity } from '../plugins/stats/activity-logger.js'
import { emitResponseChunk, emitResponseComplete, emitResponseError } from '../dashboard/response-broker.js'
import { setLastResponse } from './last-response-store.js'
import { autoCommitAndPush } from '../utils/auto-commit.js'
import { env } from '../config/env.js'

const TIMEOUT_MS = 30 * 60 * 1000

function deriveBotId(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'main'
  return envArg.replace('.env.', '')
}

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  const { telegram } = bot

  // Notify user when waiting for cross-process lock
  setLockNotify((chatId, projectName, holder) => {
    if (chatId === 0) return
    telegram.sendMessage(
      chatId,
      `⏳ *[${projectName}]* 另一個 bot (${holder}) 正在操作此專案，排隊等待中...`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  })

  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    const tag = item.project.name
    const isDashboard = item.chatId === 0
    const dashCmdId = item.dashboardCommandId ?? null
    // Resolve 'auto' backend using the router
    const resolvedAI: AIModelSelection = item.ai.backend === 'auto'
      ? autoRoute(item.prompt, true)
      : item.ai
    const aiLabel = formatAILabel(resolvedAI)
    const backend = resolvedAI.backend

    // Status message: only shows processing progress, never the response text
    // Skip Telegram messages for dashboard-only commands
    const statusMsg = isDashboard
      ? null
      : await telegram.sendMessage(
          item.chatId,
          `\u{1F680} *[${tag}]* \u{8655}\u{7406}\u{4E2D}...\n_${aiLabel}_`,
          { parse_mode: 'Markdown' }
        )

    return new Promise<void>((resolve) => {
      let resolved = false
      let accumulated = ''
      let toolCount = 0
      const toolNames: string[] = []
      const startTime = Date.now()

      const typingInterval = isDashboard
        ? null
        : setInterval(() => {
            telegram.sendChatAction(item.chatId, 'typing').catch(() => {})
          }, 5000)
      if (!isDashboard) {
        telegram.sendChatAction(item.chatId, 'typing').catch(() => {})
      }

      const cleanupImages = () => {
        for (const imagePath of item.imagePaths) {
          cleanupImage(imagePath)
        }
      }

      let tidbitTimer: ReturnType<typeof setTimeout> | null = null
      const tidbitMsgIds: number[] = []

      const done = () => {
        if (resolved) return
        resolved = true
        removeActiveRunner(item.project.path)
        if (typingInterval) clearInterval(typingInterval)
        clearInterval(tickInterval)
        clearTimeout(longRunTimer)
        if (tidbitTimer) clearTimeout(tidbitTimer)
        // Delete all tidbit messages
        if (!isDashboard) {
          for (const msgId of tidbitMsgIds) {
            telegram.deleteMessage(item.chatId, msgId).catch(() => {})
          }
        }
        cleanupImages()
        resolve()
      }

      const timer = setTimeout(() => {
        if (resolved) return
        cancelAnyRunning(item.project.path)
        if (dashCmdId) {
          emitResponseError(dashCmdId, 'Timeout (30 min)')
        }
        if (statusMsg) {
          telegram.editMessageText(
            item.chatId, statusMsg.message_id, undefined,
            `\u{23F0} *[${tag}]* \u{903E}\u{6642} (30 \u{5206}\u{9418})`,
            { parse_mode: 'Markdown' }
          ).catch(() => {})
        }
        done()
      }, TIMEOUT_MS)

      // Update status message with elapsed time + tool progress
      let lastStatusText = ''
      const updateStatus = (): void => {
        if (resolved || !statusMsg) return
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const toolInfo = toolCount > 0
          ? `\n\u{1F527} Tools: ${toolCount} (${[...new Set(toolNames)].slice(-4).join(', ')})`
          : ''
        const status = `\u{1F680} *[${tag}]* ${elapsed}s | ${aiLabel}${toolInfo}`
        if (status === lastStatusText) return
        lastStatusText = status
        telegram.editMessageText(
          item.chatId, statusMsg.message_id, undefined,
          status, { parse_mode: 'Markdown' }
        ).catch(() => {})
      }

      // Tick every second for live elapsed time
      const tickInterval = setInterval(updateStatus, 1000)

      // Long-running task reminder (120s) — skip for dashboard
      const LONG_RUN_MS = 120_000
      const longRunTimer = setTimeout(() => {
        if (resolved || isDashboard) return
        telegram.sendMessage(
          item.chatId,
          `\u{26A0}\u{FE0F} *[${tag}]* \u{5DF2}\u{904B}\u{884C}\u{8D85}\u{904E} 2 \u{5206}\u{9418}\u{FF0C}\u{53EF}\u{7528} /cancel \u{53D6}\u{6D88}`,
          { parse_mode: 'Markdown' },
        ).catch(() => {})
      }, LONG_RUN_MS)

      // Idle entertainment: send fun tidbits during long waits (skip for dashboard)
      if (!isDashboard) {
        const TIDBIT_DELAY_MS = 15_000
        const TIDBIT_INTERVAL_MS = 30_000 + Math.random() * 15_000

        tidbitTimer = setTimeout(async function sendTidbit() {
          if (resolved) return
          try {
            const tidbit = await getRandomTidbit()
            if (tidbit.type === 'audio') {
              const msg = await telegram.sendAudio(
                item.chatId,
                tidbit.audioUrl,
                { caption: tidbit.caption, title: tidbit.title },
              )
              tidbitMsgIds.push(msg.message_id)
            } else {
              const msg = await telegram.sendMessage(item.chatId, tidbit.content, { parse_mode: 'Markdown' })
              tidbitMsgIds.push(msg.message_id)
            }
          } catch { /* ignore */ }
          if (!resolved) {
            tidbitTimer = setTimeout(sendTidbit, TIDBIT_INTERVAL_MS)
          }
        }, TIDBIT_DELAY_MS)
      }

      // Track active runner for dashboard heartbeat
      const projectName = item.project.name
      setActiveRunner(item.project.path, {
        projectPath: item.project.path,
        projectName,
        backend: String(backend),
        model: resolvedAI.model,
        elapsedMs: 0,
        toolCount: 0,
        lastTool: null,
      })

      const runner = getRunner(backend)
      runner.run({
        prompt: item.prompt,
        projectPath: item.project.path,
        model: resolvedAI.model,
        sessionId: item.sessionId,
        imagePaths: item.imagePaths,
        onTextDelta: (delta, acc) => {
          accumulated = acc
          if (dashCmdId) {
            emitResponseChunk(dashCmdId, delta, acc)
          }
        },
        onToolUse: (toolName) => {
          toolCount++
          toolNames.push(toolName)
          updateRunnerTool(item.project.path, toolName)
          updateStatus()
        },
        onResult: async (result) => {
          if (resolved) return
          clearTimeout(timer)
          try {
            recordCost({
              timestamp: Date.now(),
              costUsd: result.costUsd ?? 0,
              backend: result.backend,
              model: result.model,
              project: item.project.name,
              durationMs: result.durationMs,
              toolCount,
            })

            recordActivity({
              timestamp: Date.now(),
              type: 'prompt_complete',
              project: item.project.name,
              backend: result.backend,
              model: result.model,
              durationMs: result.durationMs,
              costUsd: result.costUsd ?? 0,
              toolCount,
              promptLength: item.prompt.length,
            })

            const rawText = accumulated || result.resultText || ''

            // --- Output hooks: let plugins intercept/modify response ---
            const hookResult = await dispatchOutputHooks(rawText, {
              projectPath: item.project.path,
              projectName: item.project.name,
              model: resolvedAI.model,
              backend: String(backend),
              sessionId: item.sessionId ?? '',
            })
            const hookedText = hookResult.text

            if (hookResult.warnings.length > 0) {
              const warnText = hookResult.warnings.join('\n')
              telegram.sendMessage(item.chatId, `\u{26A0}\u{FE0F} ${warnText}`).catch(() => {})
            }

            // Save last response tail for short-reply context injection
            if (hookedText) {
              setLastResponse(item.project.path, hookedText)
            }

            const afterRun = stripRunDirectives(hookedText)

            // Execute @cmd() directives Claude included in its response
            const cmdDirectives = parseCommandDirectives(afterRun)
            for (const cmd of cmdDirectives) {
              try {
                const fakeCtx = createFakeContext({
                  chatId: item.chatId,
                  commandText: cmd.command,
                  telegram,
                })
                await dispatchPluginCommand(cmd.name, fakeCtx)
              } catch (err) {
                console.error(`[queue] @cmd(${cmd.command}) failed:`, err)
              }
            }

            const responseText = cmdDirectives.length > 0
              ? stripCommandDirectives(afterRun)
              : afterRun
            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
            const cost = (result.costUsd ?? 0).toFixed(4)

            // Emit broker complete event for dashboard
            if (dashCmdId) {
              emitResponseComplete(
                dashCmdId,
                responseText,
                deriveBotId(),
                result.costUsd ?? 0,
                Date.now() - startTime,
              )
            }

            // Auto-commit: commit + push any file changes made by AI
            if (env.AUTO_COMMIT) {
              try {
                const commitResult = autoCommitAndPush(item.project.path, item.prompt)
                if (commitResult && !isDashboard) {
                  const pushStatus = commitResult.pushed
                    ? 'pushed \u2713'
                    : commitResult.pushError
                      ? 'push failed'
                      : 'local only'
                  telegram.sendMessage(
                    item.chatId,
                    `\u{1F4E6} *[${tag}]* Auto-commit: ${commitResult.filesChanged} files | ${pushStatus}\n\`${commitResult.commitMessage}\``,
                    { parse_mode: 'Markdown' },
                  ).catch(() => {})
                }
              } catch (err) {
                console.error('[queue] auto-commit error:', err)
              }
            }

            // Dashboard-only: skip all Telegram messaging
            if (isDashboard) {
              done()
              return
            }

            const toolSummary = toolCount > 0
              ? ` | \u{1F527} ${toolCount} tools`
              : ''

            // Update status to "Done" summary
            if (statusMsg) {
              telegram.editMessageText(
                item.chatId, statusMsg.message_id, undefined,
                `\u{2705} *[${tag}]* \u{5B8C}\u{6210} | ${aiLabel} | $${cost} | ${totalTime}\u{79D2}${toolSummary}`,
                { parse_mode: 'Markdown' }
              ).catch(() => {})
            }

            // Prefer full accumulated stream text; resultText is only the final fragment
            const detectedImages = detectImagePaths(responseText)
            const validImages = detectedImages.filter((p) => existsSync(p))

            const failedImages: string[] = []
            let imageChain = Promise.resolve()
            for (const imgPath of validImages) {
              imageChain = imageChain.then(() =>
                telegram.sendPhoto(item.chatId, Input.fromLocalFile(imgPath), {
                  caption: imgPath,
                }).then(() => {})
              ).catch((err) => {
                console.error('[queue] sendPhoto error:', err)
                failedImages.push(imgPath)
              })
            }

            // After images, send text response, then check for cross-project tasks
            imageChain.then(async () => {
              if (failedImages.length > 0) {
                const names = failedImages.map((p) => p.split(/[\\/]/).pop()).join(', ')
                telegram.sendMessage(
                  item.chatId,
                  `⚠️ ${failedImages.length} 張圖片傳送失敗: ${names}`,
                ).catch(() => {})
              }

              // Dispatch cross-project tasks from raw text (before stripping)
              try {
                dispatchCrossProjectTasks(telegram, item, rawText)
              } catch (err) {
                console.error('[queue] cross-project dispatch error:', err)
              }

              if (!responseText) {
                done()
                return
              }

              // Layer 1: detect choices → appropriate buttons on last chunk
              const choiceResult = detectChoices(responseText)
              let replyButtons: ReturnType<typeof Markup.inlineKeyboard> | undefined

              if (choiceResult.type === 'yesno') {
                replyButtons = Markup.inlineKeyboard([
                  choiceResult.choices.map((c, i) =>
                    Markup.button.callback(c.label, `confirm:${i === 0 ? 'yes' : 'no'}`)
                  ),
                ])
              } else if (choiceResult.type === 'options') {
                // Store choices for callback lookup
                const choiceValues = choiceResult.choices.map((c) => c.value)
                setChoices(item.chatId, item.project.path, choiceValues)
                replyButtons = Markup.inlineKeyboard(
                  choiceResult.choices.map((c, i) => [
                    Markup.button.callback(c.label, `choice:${i}`),
                  ])
                )
              }
              // type === 'open' or 'none' → no buttons

              const cleaned = cleanMarkdown(responseText)
              const chunks = splitText(cleaned, 4096)
              let chain = Promise.resolve()
              for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i]
                const isLast = i === chunks.length - 1
                const extra = isLast && replyButtons ? { ...replyButtons } : {}
                chain = chain.then(async () => {
                  try {
                    await telegram.sendMessage(item.chatId, chunk, { parse_mode: 'Markdown', ...extra })
                  } catch {
                    // Fallback: send without parse_mode if Markdown is malformed
                    await telegram.sendMessage(item.chatId, chunk, Object.keys(extra).length > 0 ? extra : undefined)
                  }
                })
              }

              await chain

              // Layer 3: generate smart follow-up suggestions (async, non-blocking)
              if (choiceResult.type === 'none') {
                generateSuggestions(responseText, item.project.name)
                  .then(async (suggestions) => {
                    if (suggestions.length === 0) return

                    setSuggestions(item.chatId, item.project.path, suggestions)

                    const buttons = Markup.inlineKeyboard(
                      suggestions.map((s, i) => [
                        Markup.button.callback(`${s}`, `suggest:${i}`),
                      ])
                    )

                    await telegram.sendMessage(
                      item.chatId,
                      '💡 *建議下一步*',
                      { parse_mode: 'Markdown', ...buttons },
                    )
                  })
                  .catch(() => { /* silent fail */ })
              }

              done()
            }).catch(() => done())
          } catch (err) {
            console.error('[queue] onResult error:', err)
            done()
          }
        },
        onError: (error) => {
          if (resolved) return
          clearTimeout(timer)
          if (dashCmdId) {
            emitResponseError(dashCmdId, String(error))
          }
          if (isDashboard) {
            done()
            return
          }
          if (statusMsg) {
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
          } else {
            done()
          }
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

    const sessionId = getAISessionId(
      sourceItem.ai.backend === 'auto' ? 'claude' : sourceItem.ai.backend,
      task.project.path,
    )

    enqueue({
      chatId: sourceItem.chatId,
      prompt: task.prompt,
      project: task.project,
      ai: sourceItem.ai,
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
