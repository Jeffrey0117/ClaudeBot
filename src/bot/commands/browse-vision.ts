/**
 * /bv — Browse & Vision: screenshot a URL and analyse it with Gemini.
 *
 * Flow: Playwright screenshot → base64 → Gemini Vision API (direct) → reply
 *       No upload needed, no CLI needed — direct multimodal API call.
 */

import type { BotContext } from '../../types/context.js'
import { captureScreenshot, cleanupScreenshot } from '../vision/browser-pool.js'
import { analyzeImageFromPath } from '../../ai/gemini-vision.js'

// --- SSRF guard ---

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
]

function isSsrfBlocked(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return true
    return BLOCKED_HOSTS.some((re) => re.test(parsed.hostname))
  } catch {
    return true
  }
}

// --- Prompt template ---

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
  let rawUrl = text.replace(/^\/bv\s*/i, '').trim()

  if (!rawUrl) {
    await ctx.reply(
      '🌐 *網頁視覺分析*\n\n' +
      '用法: `/bv <URL>`\n\n' +
      '範例:\n' +
      '`/bv https://example.com`\n' +
      '`/bv github.com`\n\n' +
      '_截圖 → Gemini 視覺分析 UI/UX 和內容_',
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Auto-prepend https://
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`
  }

  // Validate URL
  try {
    new URL(rawUrl)
  } catch {
    await ctx.reply('URL 格式無效')
    return
  }

  if (isSsrfBlocked(rawUrl)) {
    await ctx.reply('不允許存取內部網路位址')
    return
  }

  let screenshotPath: string | null = null

  try {
    const statusMsg = await ctx.reply(`📸 截圖中... ${rawUrl}`)

    screenshotPath = await captureScreenshot(rawUrl)

    // Update status
    try {
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, undefined,
        '🔍 Gemini 分析中...',
      )
    } catch { /* ignore edit failure */ }

    const prompt = buildPrompt(rawUrl)
    const result = await analyzeImageFromPath(screenshotPath, prompt)

    // Clean up screenshot
    await cleanupScreenshot(screenshotPath)
    screenshotPath = null

    if (result.error) {
      await ctx.reply(`分析失敗: ${result.error}`)
      return
    }

    // Send result — try Markdown first, fall back to plain text
    const header = `🌐 *${escapeMd(rawUrl)}*\n\n`
    try {
      await ctx.reply(header + result.text, { parse_mode: 'MarkdownV2' })
    } catch {
      // Markdown parse failed, send as plain text
      await ctx.reply(`🌐 ${rawUrl}\n\n${result.text}`)
    }
  } catch (err) {
    if (screenshotPath) {
      await cleanupScreenshot(screenshotPath)
    }
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`截圖失敗: ${msg}`)
  }
}
