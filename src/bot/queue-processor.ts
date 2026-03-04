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
import { parseDirectives, executeDirectives, stripDirectives } from '../utils/directives.js'
import { parsePipeDirectives, executePipeDirectives, stripPipeDirectives } from '../utils/pipe-executor.js'
import { createFakeContext } from '../utils/fake-context.js'
import { dispatchPluginCommand, dispatchOutputHooks, isPluginCommand } from '../plugins/loader.js'
import { getCoreCommandHandler } from './bot.js'
import { getRandomTidbit } from '../utils/idle-tidbits.js'
import { getAISessionId } from '../ai/session-store.js'
import { detectChoices } from '../utils/choice-detector.js'
import { cleanMarkdown } from '../utils/markdown-cleaner.js'
import { generateSuggestions } from '../utils/suggestion-generator.js'
import { setSuggestions } from './suggestion-store.js'
import { setChoices } from './choice-store.js'
import { formatAILabel, resolveBackend } from '../ai/types.js'
import type { AIModelSelection, AIResult } from '../ai/types.js'
import { autoRoute } from '../ai/router.js'
import { setActiveRunner, updateRunnerTool, removeActiveRunner } from '../dashboard/runner-tracker.js'
import { recordCost } from '../plugins/cost/index.js'
import { recordActivity } from '../plugins/stats/activity-logger.js'
import { emitResponseChunk, emitResponseComplete, emitResponseError } from '../dashboard/response-broker.js'
import { setLastResponse } from './last-response-store.js'
import { extractDigest, setContext } from './context-digest-store.js'
import { autoCommitAndPush } from '../utils/auto-commit.js'
import { env } from '../config/env.js'
import { startDraft, updateDraft, finalizeDraft, cancelDraft, hasDraft } from './draft-sender.js'

const TIMEOUT_MS = 30 * 60 * 1000

function deriveBotId(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'main'
  return envArg.replace('.env.', '')
}

interface ProcessorContext {
  readonly item: QueueItem
  readonly tag: string
  readonly isDashboard: boolean
  readonly dashCmdId: string | null
  readonly resolvedAI: Readonly<AIModelSelection>
  readonly aiLabel: string
  readonly statusMsg: { readonly message_id: number } | null
  readonly startTime: number
  readonly telegram: Telegraf<BotContext>['telegram']
  accumulated: string
  toolCount: number
  resolved: boolean
  timer: ReturnType<typeof setTimeout>
  done: () => void
  draftActive: boolean
}

// --- Extracted result handler ---

async function handleRunnerResult(ctx: ProcessorContext, result: AIResult): Promise<void> {
  if (ctx.resolved) return
  clearTimeout(ctx.timer)
  try {
    recordCost({
      timestamp: Date.now(),
      costUsd: result.costUsd ?? 0,
      backend: result.backend,
      model: result.model,
      project: ctx.item.project.name,
      durationMs: result.durationMs,
      toolCount: ctx.toolCount,
    })

    recordActivity({
      timestamp: Date.now(),
      type: 'prompt_complete',
      project: ctx.item.project.name,
      backend: result.backend,
      model: result.model,
      durationMs: result.durationMs,
      costUsd: result.costUsd ?? 0,
      toolCount: ctx.toolCount,
      promptLength: ctx.item.prompt.length,
    })

    // Prefer resultText (clean final response from Claude CLI) over accumulated
    // (which includes intermediate text from ALL turns, including internal thinking)
    const rawText = result.resultText || ctx.accumulated || ''

    // Parse directives BEFORE output hooks (e.g. mdfix) run,
    // so filenames with underscores aren't escaped (REMOTE_SUCCESS → REMOTE\_SUCCESS)
    const rawAfterRun = stripRunDirectives(rawText)
    const cmdDirectives = parseCommandDirectives(rawAfterRun)
    const aiDirectives = parseDirectives(rawAfterRun)
    const pipeDirectives = parsePipeDirectives(rawAfterRun)

    // Execute @file, @confirm, @notify directives (these produce inline messages)
    if (aiDirectives.length > 0) {
      await executeDirectives(aiDirectives, ctx.item.chatId, ctx.telegram, ctx.item.project.path)
    }

    // Execute @pipe directives (CloudPipe integration)
    if (pipeDirectives.length > 0) {
      await executePipeDirectives(pipeDirectives, ctx.item.chatId, ctx.telegram)
    }

    // Strip all directives (@cmd + @file/@confirm/@notify + @pipe) before output hooks
    // NOTE: @cmd is stripped here but executed AFTER main text is sent (below)
    const afterCmdStrip = cmdDirectives.length > 0
      ? stripCommandDirectives(rawAfterRun)
      : rawAfterRun
    const afterAiStrip = aiDirectives.length > 0
      ? stripDirectives(afterCmdStrip)
      : afterCmdStrip
    const textForHooks = pipeDirectives.length > 0
      ? stripPipeDirectives(afterAiStrip)
      : afterAiStrip

    const hookResult = await dispatchOutputHooks(textForHooks, {
      projectPath: ctx.item.project.path,
      projectName: ctx.item.project.name,
      model: ctx.resolvedAI.model,
      backend: String(ctx.resolvedAI.backend),
      sessionId: ctx.item.sessionId ?? '',
    })
    const hookedText = hookResult.text

    if (hookResult.warnings.length > 0) {
      const warnText = hookResult.warnings.join('\n')
      ctx.telegram.sendMessage(ctx.item.chatId, `\u{26A0}\u{FE0F} ${warnText}`).catch(() => {})
    }

    // Extract [CTX] digest and strip from display text
    const { digest, cleaned: digestCleaned } = hookedText
      ? extractDigest(hookedText)
      : { digest: null, cleaned: '' }

    if (hookedText) {
      setLastResponse(ctx.item.project.path, digestCleaned || hookedText)
      setContext(ctx.item.project.path, digestCleaned || hookedText, digest)
    }

    const responseText = digest !== null ? digestCleaned : hookedText
    const totalTime = ((Date.now() - ctx.startTime) / 1000).toFixed(1)
    const cost = (result.costUsd ?? 0).toFixed(4)

    if (ctx.dashCmdId) {
      emitResponseComplete(
        ctx.dashCmdId,
        responseText,
        deriveBotId(),
        result.costUsd ?? 0,
        Date.now() - ctx.startTime,
      )
    }

    if (env.AUTO_COMMIT) {
      try {
        const commitResult = autoCommitAndPush(ctx.item.project.path, ctx.item.prompt)
        if (commitResult && !ctx.isDashboard) {
          const pushStatus = commitResult.pushed
            ? 'pushed \u2713'
            : commitResult.pushError
              ? 'push failed'
              : 'local only'
          ctx.telegram.sendMessage(
            ctx.item.chatId,
            `\u{1F4E6} *[${ctx.tag}]* Auto-commit: ${commitResult.filesChanged} files | ${pushStatus}\n\`${commitResult.commitMessage}\``,
            { parse_mode: 'Markdown' },
          ).catch(() => {})
        }
      } catch (err) {
        console.error('[queue] auto-commit error:', err)
      }
    }

    if (ctx.isDashboard) {
      ctx.done()
      return
    }

    const toolSummary = ctx.toolCount > 0
      ? ` | \u{1F527} ${ctx.toolCount} tools`
      : ''

    if (ctx.statusMsg) {
      ctx.telegram.editMessageText(
        ctx.item.chatId, ctx.statusMsg.message_id, undefined,
        `\u{2705} *[${ctx.tag}]* \u{5B8C}\u{6210} | ${ctx.aiLabel} | $${cost} | ${totalTime}\u{79D2}${toolSummary}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {})
    }

    const detectedImages = detectImagePaths(responseText)
    const validImages = detectedImages.filter((p) => existsSync(p))

    const failedImages: string[] = []
    let imageChain = Promise.resolve()
    for (const imgPath of validImages) {
      imageChain = imageChain.then(() =>
        ctx.telegram.sendPhoto(ctx.item.chatId, Input.fromLocalFile(imgPath), {
          caption: imgPath,
        }).then(() => {})
      ).catch((err) => {
        console.error('[queue] sendPhoto error:', err)
        failedImages.push(imgPath)
      })
    }

    await imageChain

    if (failedImages.length > 0) {
      const names = failedImages.map((p) => p.split(/[\\/]/).pop()).join(', ')
      ctx.telegram.sendMessage(
        ctx.item.chatId,
        `\u{26A0}\u{FE0F} ${failedImages.length} \u{5F35}\u{5716}\u{7247}\u{50B3}\u{9001}\u{5931}\u{6557}: ${names}`,
      ).catch(() => {})
    }

    try {
      dispatchCrossProjectTasks(ctx.telegram, ctx.item, rawText)
    } catch (err) {
      console.error('[queue] cross-project dispatch error:', err)
    }

    if (responseText) {
      await sendResponseChunks(ctx, responseText)
    }

    // Execute @cmd directives AFTER main text is sent,
    // so restart confirmations etc. appear BELOW the response
    const CMD_TIMEOUT_MS = 60_000
    for (const cmd of cmdDirectives) {
      try {
        const fakeCtx = createFakeContext({
          chatId: ctx.item.chatId,
          commandText: cmd.command,
          telegram: ctx.telegram,
        })
        const coreHandler = getCoreCommandHandler(cmd.name)
        const handler = coreHandler
          ?? (isPluginCommand(cmd.name) ? (c: BotContext) => dispatchPluginCommand(cmd.name, c) : null)

        if (handler) {
          await Promise.race([
            handler(fakeCtx),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`@cmd(${cmd.command}) 執行逾時 (${CMD_TIMEOUT_MS / 1000}s)`)), CMD_TIMEOUT_MS)
            ),
          ])
        } else {
          ctx.telegram.sendMessage(ctx.item.chatId,
            `⚠️ 未知指令: \`${cmd.command}\``, { parse_mode: 'Markdown' }
          ).catch(() => {})
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[queue] @cmd(${cmd.command}) failed:`, msg)
        ctx.telegram.sendMessage(ctx.item.chatId,
          `⚠️ @cmd(${cmd.command}) 失敗: ${msg}`
        ).catch(() => {})
      }
    }

    ctx.done()
  } catch (err) {
    console.error('[queue] onResult error:', err)
    ctx.done()
  }
}

async function sendResponseChunks(ctx: ProcessorContext, responseText: string): Promise<void> {
  const choiceResult = detectChoices(responseText)
  let replyButtons: ReturnType<typeof Markup.inlineKeyboard> | undefined

  if (choiceResult.type === 'yesno') {
    replyButtons = Markup.inlineKeyboard([
      choiceResult.choices.map((c, i) =>
        Markup.button.callback(c.label, `confirm:${i === 0 ? 'yes' : 'no'}`)
      ),
    ])
  } else if (choiceResult.type === 'options') {
    const choiceValues = choiceResult.choices.map((c) => c.value)
    setChoices(ctx.item.chatId, ctx.item.project.path, choiceValues)
    replyButtons = Markup.inlineKeyboard(
      choiceResult.choices.map((c, i) => [
        Markup.button.callback(c.label, `choice:${i}`),
      ])
    )
  }

  const cleaned = cleanMarkdown(responseText)

  // If draft was active, finalize it (this sends the final message)
  const hadDraft = ctx.draftActive
  if (hadDraft) {
    await finalizeDraft(ctx.telegram, ctx.item.chatId, cleaned)
    ctx.draftActive = false

    // If there are choice buttons, send them separately
    if (replyButtons) {
      try {
        await ctx.telegram.sendMessage(
          ctx.item.chatId,
          '請選擇：',
          { ...replyButtons }
        )
      } catch {
        // Ignore button send error
      }
    }
  } else {
    // No draft: send message chunks as usual
    const chunks = splitText(cleaned, 4096)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const isLast = i === chunks.length - 1
      const extra = isLast && replyButtons ? { ...replyButtons } : {}
      try {
        await ctx.telegram.sendMessage(ctx.item.chatId, chunk, { parse_mode: 'Markdown', ...extra })
      } catch {
        await ctx.telegram.sendMessage(ctx.item.chatId, chunk, Object.keys(extra).length > 0 ? extra : undefined)
      }
    }
  }

  // Generate smart follow-up suggestions (async, non-blocking)
  if (choiceResult.type === 'none') {
    generateSuggestions(responseText, ctx.item.project.name)
      .then(async (suggestions) => {
        if (suggestions.length === 0) return

        setSuggestions(ctx.item.chatId, ctx.item.project.path, suggestions)

        const buttons = Markup.inlineKeyboard(
          suggestions.map((s, i) => [
            Markup.button.callback(`${s}`, `suggest:${i}`),
          ])
        )

        await ctx.telegram.sendMessage(
          ctx.item.chatId,
          '\u{1F4A1} *\u{5EFA}\u{8B70}\u{4E0B}\u{4E00}\u{6B65}*',
          { parse_mode: 'Markdown', ...buttons },
        )
      })
      .catch(() => { /* silent fail */ })
  }
}

// --- Extracted error handler ---

function handleRunnerError(ctx: ProcessorContext, error: string): void {
  if (ctx.resolved) return
  clearTimeout(ctx.timer)
  if (ctx.dashCmdId) {
    emitResponseError(ctx.dashCmdId, error)
  }
  if (ctx.isDashboard) {
    ctx.done()
    return
  }
  if (ctx.statusMsg) {
    ctx.telegram.editMessageText(
      ctx.item.chatId, ctx.statusMsg.message_id, undefined,
      `\u{274C} *[${ctx.tag}]* \u{932F}\u{8AA4}\n\n\`${error}\``,
      { parse_mode: 'Markdown' }
    )
      .then(() => ctx.done())
      .catch(() => {
        ctx.telegram.editMessageText(
          ctx.item.chatId, ctx.statusMsg!.message_id, undefined,
          `Error: ${error}`
        )
          .then(() => ctx.done())
          .catch(() => ctx.done())
      })
  } else {
    ctx.done()
  }
}

// --- Main processor setup ---

export function setupQueueProcessor(bot: Telegraf<BotContext>): void {
  const { telegram } = bot

  setLockNotify((chatId, projectName, holder) => {
    if (chatId === 0) return
    telegram.sendMessage(
      chatId,
      `\u{23F3} *[${projectName}]* \u{53E6}\u{4E00}\u{500B} bot (${holder}) \u{6B63}\u{5728}\u{64CD}\u{4F5C}\u{6B64}\u{5C08}\u{6848}\u{FF0C}\u{6392}\u{968A}\u{7B49}\u{5F85}\u{4E2D}...`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  })

  setProcessor(async (item: QueueItem) => {
    const { telegram } = bot
    const tag = item.project.name
    const isDashboard = item.chatId === 0
    const dashCmdId = item.dashboardCommandId ?? null
    const resolvedAI: AIModelSelection = item.ai.backend === 'auto'
      ? autoRoute(item.prompt, true)
      : item.ai
    const aiLabel = formatAILabel(resolvedAI)
    const backend = resolvedAI.backend

    const statusMsg = isDashboard
      ? null
      : await telegram.sendMessage(
          item.chatId,
          `\u{1F680} *[${tag}]* \u{8655}\u{7406}\u{4E2D}...\n_${aiLabel}_`,
          { parse_mode: 'Markdown' }
        )

    return new Promise<void>((resolve) => {
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

      // Build processor context (shared state for result/error handlers)
      const ctx: ProcessorContext = {
        item, tag, isDashboard, dashCmdId, resolvedAI, aiLabel,
        statusMsg, startTime, telegram,
        accumulated: '',
        toolCount: 0,
        resolved: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        done: undefined as unknown as () => void,
        draftActive: false,
      }

      ctx.done = () => {
        if (ctx.resolved) return
        ctx.resolved = true
        removeActiveRunner(item.project.path)
        if (typingInterval) clearInterval(typingInterval)
        clearInterval(tickInterval)
        clearTimeout(longRunTimer)
        if (tidbitTimer) clearTimeout(tidbitTimer)
        if (!isDashboard) {
          for (const msgId of tidbitMsgIds) {
            telegram.deleteMessage(item.chatId, msgId).catch(() => {})
          }
        }
        // Cancel any active draft
        if (ctx.draftActive) {
          cancelDraft(item.chatId)
        }
        cleanupImages()
        resolve()
      }

      ctx.timer = setTimeout(() => {
        if (ctx.resolved) return
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
        ctx.done()
      }, TIMEOUT_MS)

      // Update status message with elapsed time + tool progress
      let lastStatusText = ''
      const updateStatus = (): void => {
        if (ctx.resolved || !statusMsg) return
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const toolInfo = ctx.toolCount > 0
          ? `\n\u{1F527} Tools: ${ctx.toolCount} (${[...new Set(toolNames)].slice(-4).join(', ')})`
          : ''
        const status = `\u{1F680} *[${tag}]* ${elapsed}s | ${aiLabel}${toolInfo}`
        if (status === lastStatusText) return
        lastStatusText = status
        telegram.editMessageText(
          item.chatId, statusMsg.message_id, undefined,
          status, { parse_mode: 'Markdown' }
        ).catch(() => {})
      }

      const tickInterval = setInterval(updateStatus, 3000)

      // Long-running task reminder (120s)
      const LONG_RUN_MS = 120_000
      const longRunTimer = setTimeout(() => {
        if (ctx.resolved || isDashboard) return
        telegram.sendMessage(
          item.chatId,
          `\u{26A0}\u{FE0F} *[${tag}]* \u{5DF2}\u{904B}\u{884C}\u{8D85}\u{904E} 2 \u{5206}\u{9418}\u{FF0C}\u{53EF}\u{7528} /cancel \u{53D6}\u{6D88}`,
          { parse_mode: 'Markdown', disable_notification: true },
        ).catch(() => {})
      }, LONG_RUN_MS)

      // Idle entertainment: send fun tidbits during long waits (silent — no notification)
      if (!isDashboard) {
        const TIDBIT_DELAY_MS = 15_000
        const TIDBIT_INTERVAL_MS = 30_000 + Math.random() * 15_000

        tidbitTimer = setTimeout(async function sendTidbit() {
          if (ctx.resolved) return
          try {
            const tidbit = await getRandomTidbit()
            if (tidbit.type === 'audio') {
              const msg = await telegram.sendAudio(
                item.chatId,
                tidbit.audioUrl,
                { caption: tidbit.caption, title: tidbit.title, disable_notification: true },
              )
              tidbitMsgIds.push(msg.message_id)
            } else {
              const msg = await telegram.sendMessage(item.chatId, tidbit.content, { parse_mode: 'Markdown', disable_notification: true })
              tidbitMsgIds.push(msg.message_id)
            }
          } catch { /* ignore */ }
          if (!ctx.resolved) {
            tidbitTimer = setTimeout(sendTidbit, TIDBIT_INTERVAL_MS)
          }
        }, TIDBIT_DELAY_MS)
      }

      // Track active runner for dashboard heartbeat
      setActiveRunner(item.project.path, {
        projectPath: item.project.path,
        projectName: item.project.name,
        backend: String(backend),
        model: resolvedAI.model,
        elapsedMs: 0,
        toolCount: 0,
        lastTool: null,
      })

      // Re-fetch session ID at execution time (not the stale one from enqueue time)
      // This ensures we use the latest session after previous tasks complete.
      const freshSessionId = getAISessionId(resolveBackend(resolvedAI.backend), item.project.path)

      const runner = getRunner(backend)
      runner.run({
        prompt: item.prompt,
        projectPath: item.project.path,
        model: resolvedAI.model,
        sessionId: freshSessionId,
        imagePaths: item.imagePaths,
        chatId: item.chatId,
        maxTurns: item.maxTurns,
        onTextDelta: async (delta, acc) => {
          ctx.accumulated = acc
          if (dashCmdId) {
            emitResponseChunk(dashCmdId, delta, acc)
          }

          // Stream to Telegram draft (private chat only)
          if (!isDashboard) {
            if (!ctx.draftActive) {
              // First chunk: start draft
              const draftId = await startDraft(telegram, item.chatId, acc)
              if (draftId !== null) {
                ctx.draftActive = true
              }
            } else {
              // Subsequent chunks: update draft
              await updateDraft(telegram, item.chatId, acc)
            }
          }
        },
        onToolUse: (toolName) => {
          ctx.toolCount++
          toolNames.push(toolName)
          updateRunnerTool(item.project.path, toolName)
          updateStatus()
        },
        onResult: (result) => { handleRunnerResult(ctx, result) },
        onError: (error) => { handleRunnerError(ctx, error) },
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
