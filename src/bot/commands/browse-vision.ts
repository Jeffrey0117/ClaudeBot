/**
 * /bv — Browse & Vision: screenshot analysis + web agent automation.
 *
 * Modes:
 *   /bv                          → usage help
 *   /bv <url>                    → one-shot screenshot + Gemini analysis
 *   /bv <url> <指令>              → agent loop (screenshot → analyze → act → repeat)
 *   /bv <指令>                    → continuation (if session) or Google search (if no session)
 *   /bv cancel                   → cancel active agent
 *   /bv save <name>              → save last result as playbook
 *   /bv play <name> [instruction] → replay a saved playbook
 *   /bv playbooks                → list saved playbooks
 *   /bv playbook delete <name>   → delete a playbook
 */

import type { BotContext } from '../../types/context.js'
import { captureScreenshot, cleanupScreenshot } from '../vision/browser-pool.js'
import { analyzeImageFromPath } from '../../ai/gemini-vision.js'
import { isSsrfBlocked } from '../vision/ssrf-guard.js'
import { cancelActiveAgent } from '../vision/web-agent-store.js'
import { handleContinuationMode, handleAgentMode, getSession } from './bv-agent-handlers.js'
import {
  handleSavePlaybook,
  handlePlayPlaybook,
  handleListPlaybooks,
  handlePlaybookInfo,
  handleDeletePlaybook,
} from './bv-playbook-handlers.js'

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
      '`/bv <URL> <指令>` — Agent 自動執行任務\n' +
      '`/bv <指令>` — 不給網址，自動 Google 搜尋\n\n' +
      '*連續指令:*\n' +
      '`/bv <指令>` — 有 session 時：繼續操作\n\n' +
      '*Playbook \\(動作回放\\):*\n' +
      '`/bv save` — AI 自動拆分儲存 playbook\n' +
      '`/bv save <名稱>` — 手動儲存為單一 playbook\n' +
      '`/bv play <名稱> [新指令]` — 回放 playbook\n' +
      '`/bv playbook` — 列出所有 playbook\n' +
      '`/bv playbook info <名稱>` — 查看詳細步驟\n' +
      '`/bv playbook delete <名稱>` — 刪除\n\n' +
      '💡 有 playbook 時，`/bv <URL> <指令>` 自動匹配回放\n\n' +
      '*取消:*\n' +
      '`/bv cancel` — 取消進行中的 Agent',
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

  // Playbook subcommands
  const argsLower = args.toLowerCase()
  if (argsLower === 'save' || argsLower.startsWith('save ')) {
    const saveName = argsLower === 'save' ? '' : args.slice(5).trim()
    await handleSavePlaybook(ctx, chatId, saveName)
    return
  }
  if (argsLower.startsWith('play ')) {
    await handlePlayPlaybook(ctx, chatId, args.slice(5).trim())
    return
  }
  if (argsLower === 'playbooks' || argsLower === 'playbook' || argsLower === 'playbook list') {
    await handleListPlaybooks(ctx)
    return
  }
  if (argsLower.startsWith('playbook delete ') || argsLower.startsWith('playbooks delete ')) {
    const prefix = argsLower.startsWith('playbooks') ? 'playbooks delete ' : 'playbook delete '
    await handleDeletePlaybook(ctx, args.slice(prefix.length).trim())
    return
  }
  if (argsLower.startsWith('playbook info ')) {
    await handlePlaybookInfo(ctx, args.slice(14).trim())
    return
  }

  // Parse URL and optional instruction
  const { url, instruction } = parseArgs(args)

  // No valid URL → continuation mode OR URL-less search mode
  if (!url) {
    const existingSession = getSession(chatId)
    if (existingSession) {
      // Continuation: follow-up on existing session
      await handleContinuationMode(ctx, chatId, existingSession, args)
      return
    }

    // URL-less mode: open Google and let Gemini search + navigate
    await handleAgentMode(ctx, chatId, 'https://www.google.com', args)
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
  const firstToken = parts[0]

  // Must look like a real domain: contain a dot (google.com, shop.tw)
  // or be localhost / IP address. Without a dot, it's natural language, not a URL.
  if (!firstToken.includes('.') && !firstToken.startsWith('http') && firstToken !== 'localhost') {
    return { url: null, instruction: '' }
  }

  // Auto-prepend https://
  let rawUrl = firstToken
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

// --- One-shot mode ---

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
