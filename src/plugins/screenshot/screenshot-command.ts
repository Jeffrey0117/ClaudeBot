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

async function captureDesktop(filePath: string, screenIndex?: number): Promise<void> {
  const escapedPath = filePath.replace(/'/g, "''")
  const captureAll = screenIndex === undefined

  const psScript = captureAll
    ? `Add-Type -AssemblyName System.Windows.Forms
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
    : `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${screenIndex}
if ($idx -lt 0 -or $idx -ge $screens.Length) {
  Write-Error "SCREEN_NOT_FOUND:$($screens.Length)"
  exit 1
}
$s = $screens[$idx]
$b = $s.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, [System.Drawing.Size]::new($b.Width, $b.Height))
$g.Dispose()
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`

  await ensureTempDir()
  const scriptPath = join(TEMP_DIR, 'capture-' + randomUUID() + '.ps1')
  await writeFile(scriptPath, psScript)

  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { timeout: 15_000, windowsHide: true })
  } finally {
    await unlink(scriptPath).catch(() => {})
  }
}

async function listScreens(): Promise<string[]> {
  const psScript = `Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
for ($i = 0; $i -lt $screens.Length; $i++) {
  $s = $screens[$i]
  $b = $s.Bounds
  $primary = if ($s.Primary) { " [主螢幕]" } else { "" }
  Write-Output "$($i+1): $($b.Width)x$($b.Height)$primary"
}`

  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript,
  ], { timeout: 10_000, windowsHide: true })

  return stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean)
}

export async function screenshotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/screenshot\s*/, '').trim().split(/\s+/)
  const firstArg = args[0] || ''

  // /screenshot list — show available screens
  if (firstArg === 'list' || firstArg === 'ls') {
    try {
      const screens = await listScreens()
      await ctx.reply(
        `🖥️ *可用螢幕*\n${screens.join('\n')}\n\n用法: \`/screenshot 1\` 擷取指定螢幕`,
        { parse_mode: 'Markdown' }
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.reply(`❌ 無法取得螢幕資訊: ${msg}`)
    }
    return
  }

  // /screenshot N — specific screen
  const screenNum = /^[1-9]$/.test(firstArg) ? parseInt(firstArg, 10) : 0

  if (screenNum > 0 || !firstArg) {
    const screenIndex = screenNum > 0 ? screenNum - 1 : undefined
    const label = screenNum > 0 ? `螢幕 ${screenNum}` : '全部螢幕'
    const statusMsg = await ctx.reply(`🖥️ ${label}截圖中...`)
    await ensureTempDir()
    const filePath = join(TEMP_DIR, `${randomUUID()}.png`)

    try {
      await captureDesktop(filePath, screenIndex)
      await ctx.replyWithPhoto(Input.fromLocalFile(filePath), {
        caption: `🖥️ ${label}`,
      })
      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('SCREEN_NOT_FOUND')) {
        const count = errMsg.split('SCREEN_NOT_FOUND:')[1] ?? '?'
        await ctx.telegram.editMessageText(
          chatId, statusMsg.message_id, undefined,
          `❌ 螢幕 ${screenNum} 不存在（共 ${count} 個螢幕）。用 \`/screenshot list\` 查看。`
        ).catch(() => {})
      } else {
        await ctx.telegram.editMessageText(
          chatId, statusMsg.message_id, undefined,
          `❌ 桌面截圖失敗: ${errMsg}`
        ).catch(() => {})
      }
    } finally {
      await unlink(filePath).catch(() => {})
    }
    return
  }

  // URL provided → web screenshot
  const url = firstArg
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
