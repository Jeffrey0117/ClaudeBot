import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { Input } from 'telegraf'
import type { BotContext } from '../../types/context.js'

const TEMP_DIR = join(tmpdir(), 'claudebot-screenshots')
const VIEWPORT = { width: 1280, height: 720 }
const TIMEOUT_MS = 30_000

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

export async function screenshotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/screenshot\s*/, '').trim().split(/\s+/)
  const url = args[0]
  const fullPage = args[1]?.toLowerCase() === 'full'

  if (!url) {
    await ctx.reply(
      '用法: `/screenshot <URL> [full]`\n\n例如:\n`/screenshot http://localhost:3000`\n`/screenshot https://example.com full`',
      { parse_mode: 'Markdown' }
    )
    return
  }

  try {
    new URL(url)
  } catch {
    await ctx.reply('❌ 無效的 URL。')
    return
  }

  const statusMsg = await ctx.reply('📸 截圖中...')

  await ensureTempDir()
  const filePath = join(TEMP_DIR, `${randomUUID()}.png`)

  let browser
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS })
    await page.screenshot({ path: filePath, fullPage })

    await ctx.replyWithPhoto(Input.fromLocalFile(filePath), {
      caption: `📸 ${url}${fullPage ? ' (全頁)' : ''}`,
    })

    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 截圖失敗: ${msg}`
    ).catch(() => {})
  } finally {
    await browser?.close()
    await unlink(filePath).catch(() => {})
  }
}
