/**
 * Playbook Runner — replays recorded agent actions without per-step Gemini calls.
 *
 * Single playbook: 3 phases (extract fills → execute → fallback on failure)
 * Chain mode: orchestrator chains multiple playbooks on a shared session.
 */

import type { Telegram } from 'telegraf'
import type { AgentStep } from '../../ai/gemini-agent-vision.js'
import type { Playbook, PlaybookAction } from './playbook-store.js'
import type { AgentLoopResult } from './web-agent.js'
import type { BrowserSession } from './browser-session.js'
import {
  extractFillValues,
  type FillField,
  type OrchestrationPlan,
} from '../../ai/gemini-agent-vision.js'
import { getPlaybook } from './playbook-store.js'
import { executeAction, actionLabel, runAgentLoop } from './web-agent.js'
import {
  createSession,
  sessionNavigate,
  sessionWaitForSettle,
  sessionScreenshot,
} from './browser-session.js'
import { updateAgentStep, clearActiveAgent } from './web-agent-store.js'

const TOTAL_TIMEOUT_MS = 120_000

// --- Single playbook replay ---

export interface PlaybookRunOptions {
  readonly chatId: number
  readonly playbook: Playbook
  readonly newInstruction?: string
  readonly statusMessageId: number
  readonly telegram: Telegram
  readonly abortSignal?: AbortSignal
  /** Reuse existing browser session (for chain mode). */
  readonly existingSession?: BrowserSession
  /** Skip initial navigation (for chain mode — page already in correct state). */
  readonly skipNavigation?: boolean
  /** When true, step failure returns error instead of falling back to agent loop.
   *  Used for mid-execution playbook invocation (use_playbook) to avoid nested agent loops. */
  readonly disableFallback?: boolean
}

export async function runPlaybook(options: PlaybookRunOptions): Promise<AgentLoopResult> {
  const {
    chatId, playbook, newInstruction, statusMessageId, telegram,
    abortSignal, existingSession, skipNavigation, disableFallback,
  } = options
  const actions = [...playbook.actions]
  const steps: AgentStep[] = []
  const startTime = Date.now()

  let session: BrowserSession | null = existingSession ?? null

  try {
    // --- Phase 1: Extract fill values (0-1 Gemini call) ---
    const fillActions = actions
      .map((a, i) => ({ action: a, index: i }))
      .filter((e) => e.action.type === 'fill' && e.action.text)

    const fillMap = new Map<number, string>()

    if (fillActions.length > 0 && newInstruction && newInstruction !== playbook.instruction) {
      await updateStatus(telegram, chatId, statusMessageId, '🔍 提取填入值...')

      const fields: FillField[] = fillActions.map((e) => ({
        index: e.index,
        selector: e.action.selector ?? '',
        originalValue: e.action.text ?? '',
        fieldLabel: e.action.fieldLabel,
      }))

      const result = await extractFillValues(newInstruction, fields)
      if (result.error) {
        return buildResult(steps, undefined, false, `值提取失敗: ${result.error}`)
      }

      for (const v of result.values) {
        fillMap.set(v.index, v.value)
      }
    }

    // --- Phase 2: Execute actions ---
    if (!session) {
      session = await createSession(chatId)
    }

    if (!skipNavigation) {
      await updateStatus(telegram, chatId, statusMessageId, `🌐 導航至 ${playbook.url}...`)
      await sessionNavigate(session, playbook.url)
      await sessionWaitForSettle(session)
    }

    for (let i = 0; i < actions.length; i++) {
      if (abortSignal?.aborted) {
        return buildResult(steps, undefined, false, '已取消')
      }
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        return buildResult(steps, undefined, false, `超時 (${TOTAL_TIMEOUT_MS / 1000}s)`)
      }

      const action = actions[i]
      const fillValue = fillMap.get(i)
      const resolvedAction: PlaybookAction = action.type === 'fill' && fillValue !== undefined
        ? { ...action, text: fillValue }
        : action

      const step: AgentStep = {
        thought: `Replay: ${resolvedAction.type}${resolvedAction.selector ? ` on ${resolvedAction.selector}` : ''}${resolvedAction.text ? ` "${resolvedAction.text}"` : ''}`,
        action: resolvedAction,
        done: false,
        isReplay: true,
      }

      updateAgentStep(chatId, i + 1)
      await updateStatus(
        telegram, chatId, statusMessageId,
        `▶️ 回放 ${i + 1}/${actions.length}: ${actionLabel(step)}`,
      )

      try {
        await executeAction(session, step)
        steps.push(step)
        await sessionWaitForSettle(session)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        steps.push({
          thought: `Replay failed at step ${i + 1}: ${msg}`,
          action: resolvedAction,
          done: false,
          isReplay: true,
        })

        // disableFallback: return failure instead of nesting another agent loop
        if (disableFallback) {
          return buildResult(steps, undefined, false, `回放步驟 ${i + 1} 失敗: ${msg}`)
        }

        // --- Phase 3: Fallback to Gemini agent loop ---
        await updateStatus(
          telegram, chatId, statusMessageId,
          `⚠️ 回放步驟 ${i + 1} 失敗，切換 AI 模式...`,
        )

        const fallbackInstruction = newInstruction ?? playbook.instruction

        const fallbackResult = await runAgentLoop({
          chatId,
          url: playbook.url,
          instruction: fallbackInstruction,
          statusMessageId,
          telegram,
          abortSignal,
          existingSession: session,
        })

        const mergedSteps = [...steps, ...fallbackResult.steps]
        return {
          steps: mergedSteps,
          finalScreenshot: fallbackResult.finalScreenshot,
          success: fallbackResult.success,
          summary: `回放失敗於步驟 ${i + 1}，AI 接手: ${fallbackResult.summary}`,
        }
      }
    }

    // All steps replayed — take final screenshot
    let finalScreenshot: string | undefined
    try {
      finalScreenshot = await sessionScreenshot(session)
    } catch { /* page may have navigated */ }

    await updateStatus(telegram, chatId, statusMessageId, `✅ 回放完成 (${steps.length} 步)`)
    return buildResult(steps, finalScreenshot, true, `回放完成 (${steps.length} 步)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return buildResult(steps, undefined, false, `回放錯誤: ${msg}`)
  } finally {
    // Only clear active agent if we own the session (not chain mode)
    if (!existingSession) {
      clearActiveAgent(chatId)
    }
  }
}

// --- Chain mode: execute multiple playbooks on a shared session ---

export interface PlaybookChainOptions {
  readonly chatId: number
  readonly url: string
  readonly plan: OrchestrationPlan
  readonly statusMessageId: number
  readonly telegram: Telegram
  readonly abortSignal?: AbortSignal
}

export async function runPlaybookChain(options: PlaybookChainOptions): Promise<AgentLoopResult> {
  const { chatId, url, plan, statusMessageId, telegram, abortSignal } = options
  const allSteps: AgentStep[] = []
  const playbookNames: string[] = []

  let session: BrowserSession | null = null

  try {
    // Create session and navigate once
    session = await createSession(chatId)
    await updateStatus(telegram, chatId, statusMessageId, `🌐 導航至 ${url}...`)
    await sessionNavigate(session, url)
    await sessionWaitForSettle(session)

    // Execute each matched playbook in sequence
    for (let pi = 0; pi < plan.matchedPlaybooks.length; pi++) {
      if (abortSignal?.aborted) {
        return buildResult(allSteps, undefined, false, '已取消')
      }

      const entry = plan.matchedPlaybooks[pi]
      const playbook = getPlaybook(entry.playbookName)
      if (!playbook) {
        // Playbook disappeared — skip to agent fallback
        allSteps.push({
          thought: `Playbook "${entry.playbookName}" not found, skipping`,
          action: { type: 'done' },
          done: false,
        })
        continue
      }

      playbookNames.push(playbook.name)

      await updateStatus(
        telegram, chatId, statusMessageId,
        `📋 ${pi + 1}/${plan.matchedPlaybooks.length}: 回放 "${playbook.name}"...`,
      )

      const result = await runPlaybook({
        chatId,
        playbook,
        newInstruction: entry.fillInstruction || undefined,
        statusMessageId,
        telegram,
        abortSignal,
        existingSession: session,
        skipNavigation: true, // already navigated
      })

      allSteps.push(...result.steps)

      // If a playbook failed and fell back to agent, stop the chain
      if (!result.success) {
        return {
          steps: allSteps,
          finalScreenshot: result.finalScreenshot,
          success: false,
          summary: `鏈式回放: "${playbook.name}" 失敗 — ${result.summary}`,
        }
      }
    }

    // If there's remaining instruction, run agent loop
    if (plan.remainingInstruction) {
      await updateStatus(
        telegram, chatId, statusMessageId,
        `🤖 AI 處理剩餘指令: ${plan.remainingInstruction.slice(0, 30)}...`,
      )

      const agentResult = await runAgentLoop({
        chatId,
        url,
        instruction: plan.remainingInstruction,
        statusMessageId,
        telegram,
        abortSignal,
        existingSession: session,
      })

      allSteps.push(...agentResult.steps)

      const chainNames = playbookNames.join(' → ')
      return {
        steps: allSteps,
        finalScreenshot: agentResult.finalScreenshot,
        success: agentResult.success,
        summary: `鏈式回放 [${chainNames}] + AI 補完: ${agentResult.summary}`,
      }
    }

    // All playbooks succeeded, no remaining instruction
    let finalScreenshot: string | undefined
    try {
      finalScreenshot = await sessionScreenshot(session)
    } catch { /* ignore */ }

    const chainNames = playbookNames.join(' → ')
    await updateStatus(
      telegram, chatId, statusMessageId,
      `✅ 鏈式回放完成 [${chainNames}] (${allSteps.length} 步)`,
    )

    return buildResult(
      allSteps, finalScreenshot, true,
      `鏈式回放完成 [${chainNames}] (${allSteps.length} 步)`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return buildResult(allSteps, undefined, false, `鏈式回放錯誤: ${msg}`)
  } finally {
    clearActiveAgent(chatId)
  }
}

// --- Helpers ---

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
    // ignore edit failures
  }
}
