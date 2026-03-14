/**
 * /bv — Browse & Vision: screenshot analysis + web agent automation.
 *
 * Modes:
 *   /bv                  → usage help
 *   /bv <url>            → one-shot screenshot + Gemini analysis
 *   /bv <url> <指令>      → agent loop (screenshot → analyze → act → repeat)
 *   /bv <指令>            → continuation: follow-up on existing session
 *   /bv cancel           → cancel active agent
 */

import type { BotContext } from '../../types/context.js'
import { captureScreenshot, cleanupScreenshot } from '../vision/browser-pool.js'
import { analyzeImageFromPath } from '../../ai/gemini-vision.js'
import { isSsrfBlocked } from '../vision/ssrf-guard.js'
import { runAgentLoop } from '../vision/web-agent.js'
import { getSession } from '../vision/browser-session.js'
import {
  setActiveAgent,
  getActiveAgent,
  cancelActiveAgent,
} from '../vision/web-agent-store.js'

// --- Prompt template (one-shot mode) ---

function buildPrompt(pageUrl: string): string {
  return (
    '請用繁體中文回覆。\n' +
    '這是一張網頁截圖，來自: ' + pageUrl + '\n\n' +
    '請分析這張截圖：\n' +
    '1. 描述頁面的視覺佈局和主要內容\n' +
    '2. 分析 UI/UX 特色（配色、排版、互動元素）\n' +
    '3. 總結頁面目的和關鍵資訊\n' +
    '4. 如果有改善建議，請提出'
  )
}

// --- Markdown escape for Telegram ---

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

// --- Command handler ---

export async function browseVisionCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  const args = text.replace(/^\/bv\s*/i, '').trim()

  // No args → usage help
  if (!args) {
    await ctx.reply(
      '🌐 *網頁視覺分析 \\+ 自動化*\n\n' +
      '*截圖分析:*\n' +
      '`/bv <URL>` — 截圖 → Gemini 分析\n\n' +
      '*網頁自動化:*\n' +
      '`/bv <URL> <指令>` — Agent 自動執行任務\n\n' +
      '*連續指令:*\n' +
      '`/bv <指令>` — 在目前頁面繼續操作\n\n' +
      '*取消:*\n' +
      '`/bv cancel` — 取消進行中的 Agent\n\n' +
      '*範例:*\n' +
      '`/bv example\\.com`\n' +
      '`/bv google\\.com 搜尋 Claude Code`\n' +
      '`/bv 點擊第一個結果`',
      { parse_mode: 'MarkdownV2' },
    )
    return
  }

  // Cancel command
  if (args.toLowerCase() === 'cancel') {
    if (cancelActiveAgent(chatId)) {
      await ctx.reply('🛑 已取消網頁自動化')
    } else {
      await ctx.reply('💤 沒有進行中的網頁自動化任務')
    }
    return
  }

  // Parse URL and optional instruction
  const { url, instruction } = parseArgs(args)

  // No valid URL → treat entire args as follow-up instruction (continuation mode)
  if (!url) {
    const existingSession = getSession(chatId)
    if (!existingSession) {
      await ctx.reply('💤 沒有進行中的瀏覽器 session。\n請先用 `/bv <URL> <指令>` 開始。', { parse_mode: 'Markdown' })
      return
    }
    await handleContinuationMode(ctx, chatId, existingSession, args)
    return
  }

  if (isSsrfBlocked(url)) {
    await ctx.reply('不允許存取內部網路位址')
    return
  }

  if (instruction) {
    await handleAgentMode(ctx, chatId, url, instruction)
  } else {
    await handleOneShotMode(ctx, chatId, url)
  }
}

// --- Parse URL and instruction from args ---

function parseArgs(args: string): { url: string | null; instruction: string } {
  // Try to extract URL from the beginning
  const parts = args.split(/\s+/)
  let rawUrl = parts[0]

  // Auto-prepend https://
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`
  }

  try {
    new URL(rawUrl)
  } catch {
    return { url: null, instruction: '' }
  }

  const instruction = parts.slice(1).join(' ').trim()
  return { url: rawUrl, instruction }
}

// --- One-shot mode (existing behavior) ---

async function handleOneShotMode(
  ctx: BotContext,
  chatId: number,
  url: string,
): Promise<void> {
  let screenshotPath: string | null = null

  try {
    const statusMsg = await ctx.reply(`📸 截圖中... ${url}`)

    screenshotPath = await captureScreenshot(url)

    try {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, undefined,
        '🔍 Gemini 分析中...',
      )
    } catch { /* ignore edit failure */ }

    const prompt = buildPrompt(url)
    const result = await analyzeImageFromPath(screenshotPath, prompt)

    await cleanupScreenshot(screenshotPath)
    screenshotPath = null

    if (result.error) {
      await ctx.reply(`分析失敗: ${result.error}`)
      return
    }

    const header = `🌐 *${escapeMd(url)}*\n\n`
    try {
      await ctx.reply(header + result.text, { parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.reply(`🌐 ${url}\n\n${result.text}`)
    }
  } catch (err) {
    if (screenshotPath) await cleanupScreenshot(screenshotPath)
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`截圖失敗: ${msg}`)
  }
}

// --- Continuation mode (follow-up instruction on existing session) ---

async function handleContinuationMode(
  ctx: BotContext,
  chatId: number,
  existingSession: import('../vision/browser-session.js').BrowserSession,
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
    const result = await runAgentLoop({
      chatId,
      url: pageUrl,
      instruction,
      statusMessageId: statusMsg.message_id,
      telegram: ctx.telegram,
      abortSignal: abortController.signal,
      existingSession,
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

// --- Agent mode (new) ---

async function handleAgentMode(
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
    const result = await runAgentLoop({
      chatId,
      url,
      instruction,
      statusMessageId: statusMsg.message_id,
      telegram: ctx.telegram,
      abortSignal: abortController.signal,
    })

    // Build summary
    const stepsText = result.steps
      .map((s, i) => `${i + 1}. ${s.thought}`)
      .join('\n')

    const icon = result.success ? '✅' : '⚠️'
    const summary = (
      `${icon} *網頁自動化完成*\n\n` +
      `🌐 ${escapeMd(url)}\n` +
      `🎯 ${escapeMd(instruction)}\n` +
      `📊 ${result.steps.length} 步驟\n\n` +
      `*結果:* ${escapeMd(result.summary)}\n\n` +
      `*步驟記錄:*\n${escapeMd(stepsText)}`
    )

    try {
      await ctx.reply(summary, { parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.reply(
        `${icon} 網頁自動化完成\n\n` +
        `🌐 ${url}\n` +
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
