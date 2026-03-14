/**
 * Web Agent Loop — the core engine for automated web interaction.
 *
 * Flow: screenshot → Gemini analyze → execute action → repeat
 * Max 10 steps, 120s total timeout, self-correcting on selector errors.
 * Stuck detection: 3 consecutive failures → abort.
 */

import type { Telegram } from 'telegraf'
import {
  createSession,
  sessionNavigate,
  sessionScreenshot,
  sessionAccessTree,
  sessionClick,
  sessionFill,
  sessionPress,
  sessionScroll,
  sessionWaitForSettle,
  closeSession,
} from './browser-session.js'
import { isSsrfBlocked } from './ssrf-guard.js'
import { analyzeForAction, type AgentStep } from '../../ai/gemini-agent-vision.js'
import { updateAgentStep, clearActiveAgent } from './web-agent-store.js'

const DEFAULT_MAX_STEPS = 10
const TOTAL_TIMEOUT_MS = 120_000
const MAX_CONSECUTIVE_FAILURES = 3

export interface AgentLoopOptions {
  readonly chatId: number
  readonly url: string
  readonly instruction: string
  readonly maxSteps?: number
  readonly statusMessageId: number
  readonly telegram: Telegram
  readonly abortSignal?: AbortSignal
}

export interface AgentLoopResult {
  readonly steps: readonly AgentStep[]
  readonly finalScreenshot?: string
  readonly success: boolean
  readonly summary: string
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    chatId,
    url,
    instruction,
    maxSteps = DEFAULT_MAX_STEPS,
    statusMessageId,
    telegram,
    abortSignal,
  } = options

  const steps: AgentStep[] = []
  const startTime = Date.now()
  let finalScreenshot: string | undefined
  let consecutiveFailures = 0
  const failedSelectors = new Set<string>()

  let session: Awaited<ReturnType<typeof createSession>> | null = null

  try {
    session = await createSession(chatId)

    // Navigate to initial URL
    await updateStatus(telegram, chatId, statusMessageId, '🌐 導航中...')
    await sessionNavigate(session, url)
    await sessionWaitForSettle(session)

    for (let i = 0; i < maxSteps; i++) {
      // Check abort
      if (abortSignal?.aborted) {
        return buildResult(steps, finalScreenshot, false, '已取消')
      }

      // Check total timeout
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        return buildResult(steps, finalScreenshot, false, `超時 (${TOTAL_TIMEOUT_MS / 1000}s)`)
      }

      // Update step counter
      updateAgentStep(chatId, i + 1)
      await updateStatus(
        telegram, chatId, statusMessageId,
        `🤖 步驟 ${i + 1}/${maxSteps}: 截圖分析中...`,
      )

      // 1. Screenshot + accessibility tree
      let screenshot: string
      try {
        screenshot = await sessionScreenshot(session)
        finalScreenshot = screenshot
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return buildResult(steps, finalScreenshot, false, `截圖失敗: ${msg}`)
      }

      let accessTree: string
      try {
        accessTree = await sessionAccessTree(session)
      } catch {
        accessTree = '(accessibility tree unavailable)'
      }

      // Build failure context for Gemini
      const failedContext = failedSelectors.size > 0
        ? `\n\nPreviously failed selectors (DO NOT reuse): ${[...failedSelectors].join(', ')}`
        : ''
      const instructionWithContext = instruction + failedContext

      // 2. Ask Gemini for next action
      const result = await analyzeForAction(screenshot, accessTree, instructionWithContext, steps)

      if (result.error || !result.step) {
        const errorMsg = result.error ?? 'Gemini 未回覆'
        await updateStatus(
          telegram, chatId, statusMessageId,
          `❌ 步驟 ${i + 1}: ${errorMsg}`,
        )
        return buildResult(steps, finalScreenshot, false, errorMsg)
      }

      const step = result.step
      steps.push(step)

      // 3. Check if done
      if (step.done || step.action.type === 'done') {
        await updateStatus(
          telegram, chatId, statusMessageId,
          `✅ 完成 (${steps.length} 步)`,
        )
        try {
          finalScreenshot = await sessionScreenshot(session)
        } catch { /* page may have navigated away */ }
        return buildResult(steps, finalScreenshot, true, step.thought)
      }

      // 4. Execute action
      await updateStatus(
        telegram, chatId, statusMessageId,
        `🤖 步驟 ${i + 1}/${maxSteps}: ${actionLabel(step)}`,
      )

      try {
        await executeAction(session, step)
        consecutiveFailures = 0 // reset on success
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        consecutiveFailures++

        // Track failed selectors so Gemini won't reuse them
        if (step.action.selector) {
          failedSelectors.add(step.action.selector)
        }

        // Replace the step with error info
        steps.pop()
        steps.push({
          thought: `Action failed: ${msg}`,
          action: step.action,
          done: false,
        })

        // Stuck detection: too many consecutive failures → abort
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await updateStatus(
            telegram, chatId, statusMessageId,
            `❌ 連續 ${MAX_CONSECUTIVE_FAILURES} 次失敗，停止`,
          )
          return buildResult(
            steps, finalScreenshot, false,
            `連續 ${MAX_CONSECUTIVE_FAILURES} 次操作失敗，無法繼續`,
          )
        }

        await updateStatus(
          telegram, chatId, statusMessageId,
          `⚠️ 步驟 ${i + 1}: 失敗 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})，換方式重試...`,
        )
        continue
      }

      // 5. Wait for page to settle
      await sessionWaitForSettle(session)
    }

    // Max steps reached
    await updateStatus(
      telegram, chatId, statusMessageId,
      `⚠️ 已達最大步驟數 (${maxSteps})`,
    )
    try {
      finalScreenshot = await sessionScreenshot(session)
    } catch { /* ignore */ }

    return buildResult(
      steps, finalScreenshot, false,
      `已達最大步驟數 (${maxSteps})`,
    )
  } catch (err) {
    // Catch-all for unexpected errors (Playwright crash, etc.)
    const msg = err instanceof Error ? err.message : String(err)
    return buildResult(steps, finalScreenshot, false, `Agent 錯誤: ${msg}`)
  } finally {
    clearActiveAgent(chatId)
    await closeSession(chatId)
  }
}

// --- Action execution ---

async function executeAction(
  session: import('./browser-session.js').BrowserSession,
  step: AgentStep,
): Promise<void> {
  const { action } = step

  switch (action.type) {
    case 'click':
      if (!action.selector) throw new Error('click 需要 selector')
      await sessionClick(session, action.selector)
      break

    case 'fill':
      if (!action.selector) throw new Error('fill 需要 selector')
      if (!action.text) throw new Error('fill 需要 text')
      await sessionFill(session, action.selector, action.text)
      break

    case 'press':
      if (!action.text) throw new Error('press 需要 key name')
      await sessionPress(session, action.text)
      break

    case 'scroll':
      await sessionScroll(session, action.text ?? 'down')
      break

    case 'navigate':
      if (!action.text) throw new Error('navigate 需要 URL')
      if (isSsrfBlocked(action.text)) throw new Error('不允許存取內部網路位址')
      await sessionNavigate(session, action.text)
      break

    case 'done':
      break

    default:
      throw new Error(`未知動作: ${action.type}`)
  }
}

// --- Helpers ---

function actionLabel(step: AgentStep): string {
  const { action } = step
  switch (action.type) {
    case 'click': return `點擊 ${action.selector ?? ''}`
    case 'fill': return `填入 "${action.text ?? ''}" → ${action.selector ?? ''}`
    case 'press': return `按鍵 ${action.text ?? ''}`
    case 'scroll': return `捲動 ${action.text ?? 'down'}`
    case 'navigate': return `導航 ${action.text ?? ''}`
    case 'done': return '完成'
    default: return action.type
  }
}

function buildResult(
  steps: readonly AgentStep[],
  finalScreenshot: string | undefined,
  success: boolean,
  summary: string,
): AgentLoopResult {
  return { steps, finalScreenshot, success, summary }
}

async function updateStatus(
  telegram: Telegram,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await telegram.editMessageText(chatId, messageId, undefined, text)
  } catch {
    // ignore edit failures (message not modified, etc.)
  }
}
