/**
 * Agent mode handlers for /bv command.
 * Continuation mode, agent mode, orchestrator, result sending.
 */

import type { BotContext } from '../../types/context.js'
import { runAgentLoop } from '../vision/web-agent.js'
import type { AgentLoopResult } from '../vision/web-agent.js'
import { getSession } from '../vision/browser-session.js'
import type { BrowserSession } from '../vision/browser-session.js'
import {
  setActiveAgent,
  getActiveAgent,
  setLastResult,
} from '../vision/web-agent-store.js'
import { getBvFiles, clearBvFiles } from '../vision/bv-file-store.js'
import {
  getPlaybookSummaries,
  getSkillsForDomain,
} from '../vision/playbook-store.js'
import { runPlaybookChain } from '../vision/playbook-runner.js'
import { planPlaybookChain } from '../../ai/gemini-agent-vision.js'

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export { getSession, getActiveAgent }

export async function handleContinuationMode(
  ctx: BotContext,
  chatId: number,
  existingSession: BrowserSession,
  instruction: string,
): Promise<void> {
  // Check if already running
  if (getActiveAgent(chatId)) {
    await ctx.reply('⚠️ 已有進行中的自動化任務。\n用 `/bv cancel` 取消後再試。', { parse_mode: 'Markdown' })
    return
  }

  const pageUrl = existingSession.page.url()
  const statusMsg = await ctx.reply(`🤖 繼續操作...\n🎯 ${instruction}\n🌐 ${pageUrl}`)

  const abortController = new AbortController()

  setActiveAgent(chatId, {
    chatId,
    url: pageUrl,
    instruction,
    abortController,
    startedAt: Date.now(),
    currentStep: 0,
    statusMessageId: statusMsg.message_id,
  })

  try {
    const userFiles = getBvFiles(chatId)
    const result = await runAgentLoop({
      chatId,
      url: pageUrl,
      instruction,
      statusMessageId: statusMsg.message_id,
      telegram: ctx.telegram,
      abortSignal: abortController.signal,
      existingSession,
      availableFiles: userFiles.length > 0 ? userFiles : undefined,
    })

    // Clear bv files after successful agent run
    if (result.success) clearBvFiles(chatId)

    // Cache result for /bv save
    setLastResult(chatId, {
      url: pageUrl,
      instruction,
      steps: result.steps,
      success: result.success,
      timestamp: Date.now(),
    })

    // Build summary
    const stepsText = result.steps
      .map((s, i) => `${i + 1}. ${s.thought}`)
      .join('\n')

    const icon = result.success ? '✅' : '⚠️'
    const summary = (
      `${icon} *繼續操作完成*\n\n` +
      `🌐 ${escapeMd(pageUrl)}\n` +
      `🎯 ${escapeMd(instruction)}\n` +
      `📊 ${result.steps.length} 步驟\n\n` +
      `*結果:* ${escapeMd(result.summary)}\n\n` +
      `*步驟記錄:*\n${escapeMd(stepsText)}`
    )

    try {
      await ctx.reply(summary, { parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.reply(
        `${icon} 繼續操作完成\n\n` +
        `🌐 ${pageUrl}\n` +
        `🎯 ${instruction}\n` +
        `📊 ${result.steps.length} 步驟\n\n` +
        `結果: ${result.summary}\n\n` +
        `步驟記錄:\n${stepsText}`,
      )
    }

    // Send final screenshot if available
    if (result.finalScreenshot) {
      try {
        const buf = Buffer.from(result.finalScreenshot, 'base64')
        await ctx.replyWithPhoto({ source: buf, filename: 'final.png' })
      } catch {
        // ignore photo send failure
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 自動化失敗: ${msg}`)
  }
}

export async function handleAgentMode(
  ctx: BotContext,
  chatId: number,
  url: string,
  instruction: string,
): Promise<void> {
  // Check if already running
  if (getActiveAgent(chatId)) {
    await ctx.reply('⚠️ 已有進行中的自動化任務。\n用 `/bv cancel` 取消後再試。', { parse_mode: 'Markdown' })
    return
  }

  const statusMsg = await ctx.reply(`🤖 啟動網頁自動化...\n🎯 ${instruction}\n🌐 ${url}`)

  const abortController = new AbortController()

  setActiveAgent(chatId, {
    chatId,
    url,
    instruction,
    abortController,
    startedAt: Date.now(),
    currentStep: 0,
    statusMessageId: statusMsg.message_id,
  })

  try {
    // --- Try orchestrator: match against existing playbooks ---
    const orchestratorResult = await tryOrchestrator(
      ctx, chatId, url, instruction, statusMsg.message_id, abortController,
    )

    if (orchestratorResult) {
      // Orchestrator handled it — cache result and send summary
      setLastResult(chatId, {
        url,
        instruction,
        steps: orchestratorResult.steps,
        success: orchestratorResult.success,
        timestamp: Date.now(),
      })
      await sendAgentResult(ctx, chatId, url, instruction, orchestratorResult)
      return
    }

    // --- No playbook match — full agent loop (with playbook skills awareness) ---
    const domainSkills = getSkillsForDomain(url)
    const userFiles = getBvFiles(chatId)
    const result = await runAgentLoop({
      chatId,
      url,
      instruction,
      statusMessageId: statusMsg.message_id,
      telegram: ctx.telegram,
      abortSignal: abortController.signal,
      playbookSkills: domainSkills.length > 0 ? domainSkills : undefined,
      availableFiles: userFiles.length > 0 ? userFiles : undefined,
    })

    // Clear bv files after successful agent run
    if (result.success) clearBvFiles(chatId)

    // Cache result for /bv save
    setLastResult(chatId, {
      url,
      instruction,
      steps: result.steps,
      success: result.success,
      timestamp: Date.now(),
    })

    await sendAgentResult(ctx, chatId, url, instruction, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 自動化失敗: ${msg}`)
  }
}

/** Try to match instruction against saved playbooks. Returns result if matched, null otherwise. */
async function tryOrchestrator(
  ctx: BotContext,
  chatId: number,
  url: string,
  instruction: string,
  statusMessageId: number,
  abortController: AbortController,
): Promise<AgentLoopResult | null> {
  const summaries = getPlaybookSummaries()
  if (summaries.length === 0) return null

  try {
    await ctx.telegram.editMessageText(
      chatId, statusMessageId, undefined,
      '🔍 檢查 playbook 資料庫...',
    )
  } catch { /* ignore */ }

  const planResult = await planPlaybookChain(url, instruction, summaries)
  if (planResult.error || !planResult.plan) return null

  const plan = planResult.plan
  const names = plan.matchedPlaybooks.map((p) => p.playbookName).join(' → ')

  try {
    await ctx.telegram.editMessageText(
      chatId, statusMessageId, undefined,
      `📋 匹配到 playbook: ${names}\n▶️ 開始鏈式回放...`,
    )
  } catch { /* ignore */ }

  return runPlaybookChain({
    chatId,
    url,
    plan,
    statusMessageId,
    telegram: ctx.telegram,
    abortSignal: abortController.signal,
  })
}

/** Send agent/playbook result summary + screenshot. */
export async function sendAgentResult(
  ctx: BotContext,
  chatId: number,
  url: string,
  instruction: string,
  result: AgentLoopResult,
): Promise<void> {
  const replayCount = result.steps.filter((s) => s.isReplay).length
  const aiCount = result.steps.length - replayCount
  const stepsText = result.steps
    .map((s, i) => `${s.isReplay ? '▶️' : `${i + 1}.`} ${s.thought}`)
    .join('\n')

  const icon = result.success ? '✅' : '⚠️'
  const statsLine = replayCount > 0
    ? `📊 ${result.steps.length} 步驟 \\(🤖${aiCount} \\+ ▶️${replayCount} 回放\\)`
    : `📊 ${result.steps.length} 步驟`
  const summary = (
    `${icon} *網頁自動化完成*\n\n` +
    `🌐 ${escapeMd(url)}\n` +
    `🎯 ${escapeMd(instruction)}\n` +
    `${statsLine}\n\n` +
    `*結果:* ${escapeMd(result.summary)}\n\n` +
    `*步驟記錄:*\n${escapeMd(stepsText)}`
  )

  try {
    await ctx.reply(summary, { parse_mode: 'MarkdownV2' })
  } catch {
    const plainStats = replayCount > 0
      ? `📊 ${result.steps.length} 步驟 (🤖${aiCount} + ▶️${replayCount} 回放)`
      : `📊 ${result.steps.length} 步驟`
    await ctx.reply(
      `${icon} 網頁自動化完成\n\n` +
      `🌐 ${url}\n` +
      `🎯 ${instruction}\n` +
      `${plainStats}\n\n` +
      `結果: ${result.summary}\n\n` +
      `步驟記錄:\n${stepsText}`,
    )
  }

  if (result.finalScreenshot) {
    try {
      const buf = Buffer.from(result.finalScreenshot, 'base64')
      await ctx.replyWithPhoto({ source: buf, filename: 'final.png' })
    } catch {
      // ignore
    }
  }

  // Hint: save as playbook on clean success
  if (result.success && result.steps.length >= 2) {
    try {
      await ctx.reply('💡 用 `/bv save` 儲存此流程為 playbook，下次自動回放', { parse_mode: 'Markdown' })
    } catch { /* ignore */ }
  }
}
