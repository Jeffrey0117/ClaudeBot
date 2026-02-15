import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { Input } from 'telegraf'
import type { BotContext } from '../../types/context.js'

const execFileAsync = promisify(execFile)

const TEMP_DIR = join(tmpdir(), 'claudebot-screenshots')
const VIEWPORT = { width: 1280, height: 720 }
const TIMEOUT_MS = 30_000

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

async function captureDesktop(filePath: string): Promise<void> {
  const escapedPath = filePath.replace(/'/g, "''")
  const psScript = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum
$w = [int]($maxX - $minX)
$h = [int]($maxY - $minY)
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$minX, [int]$minY, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`

  await ensureTempDir()
  const scriptPath = join(TEMP_DIR, 'capture-' + randomUUID() + '.ps1')
  await writeFile(scriptPath, psScript)

  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { timeout: 15_000 })
  } finally {
    await unlink(scriptPath).catch(() => {})
  }
}

export async function screenshotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/screenshot\s*/, '').trim().split(/\s+/)
  const url = args[0] || ''

  // No URL → desktop screenshot
  if (!url) {
    const statusMsg = await ctx.reply('🖥️ 桌面截圖中...')
    await ensureTempDir()
    const filePath = join(TEMP_DIR, `${randomUUID()}.png`)

    try {
      await captureDesktop(filePath)
      await ctx.replyWithPhoto(Input.fromLocalFile(filePath), {
        caption: '🖥️ 桌面截圖',
      })
      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, undefined,
        `❌ 桌面截圖失敗: ${msg}`
      ).catch(() => {})
    } finally {
      await unlink(filePath).catch(() => {})
    }
    return
  }

  // URL provided → web screenshot
  const fullPage = args[1]?.toLowerCase() === 'full'

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
