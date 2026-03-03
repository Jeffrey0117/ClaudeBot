import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { Input } from 'telegraf'
import type { BotContext } from '../../types/context.js'
import { getPairing, getCodeForChat } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

const execFileAsync = promisify(execFile)

const TEMP_DIR = join(tmpdir(), 'claudebot-screenshots')
const VIEWPORT = { width: 1280, height: 720 }
const TIMEOUT_MS = 30_000

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

async function captureDesktopMac(filePath: string, screenIndex?: number): Promise<void> {
  const args = screenIndex !== undefined
    ? ['-D', String(screenIndex + 1), filePath]
    : [filePath]
  await execFileAsync('screencapture', args, { timeout: 15_000 })
}

async function captureDesktopWindows(filePath: string, screenIndex?: number): Promise<void> {
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

async function captureDesktop(filePath: string, screenIndex?: number): Promise<void> {
  if (process.platform === 'darwin') {
    await captureDesktopMac(filePath, screenIndex)
  } else if (process.platform === 'win32') {
    await captureDesktopWindows(filePath, screenIndex)
  } else {
    throw new Error('桌面截圖僅支援 Windows 和 macOS')
  }
}

async function listScreensMac(): Promise<string[]> {
  const { stdout } = await execFileAsync('system_profiler', [
    'SPDisplaysDataType',
  ], { timeout: 10_000 })
  const lines: string[] = []
  const resMatches = [...stdout.matchAll(/Resolution:\s*(\d+\s*x\s*\d+)/gi)]
  const mainMatch = stdout.match(/Main Display:\s*(Yes)/i)
  resMatches.forEach((m, i) => {
    const primary = (i === 0 && mainMatch) ? ' [主螢幕]' : ''
    lines.push(`${i + 1}: ${m[1].replace(/\s/g, '')}${primary}`)
  })
  return lines.length > 0 ? lines : ['1: (無法取得解析度)']
}

async function listScreensWindows(): Promise<string[]> {
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

async function listScreens(): Promise<string[]> {
  if (process.platform === 'darwin') return listScreensMac()
  if (process.platform === 'win32') return listScreensWindows()
  throw new Error('螢幕列表僅支援 Windows 和 macOS')
}

// --- Remote screenshot via relay ---

async function captureRemoteScreenshot(ctx: BotContext, code: string): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const statusMsg = await ctx.reply('🖥️ 遠端截圖中...')

  try {
    // Run PowerShell screenshot on remote, save to temp file
    const remotePath = '$env:TEMP\\claudebot-screenshot.png'
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$screens = [System.Windows.Forms.Screen]::AllScreens',
      '$minX = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum',
      '$minY = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum',
      '$maxX = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum',
      '$maxY = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum',
      '$w = [int]($maxX - $minX)',
      '$h = [int]($maxY - $minY)',
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen([int]$minX, [int]$minY, 0, 0, [System.Drawing.Size]::new($w, $h))',
      '$g.Dispose()',
      `$bmp.Save("${remotePath}", [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$bmp.Dispose()',
      `Write-Output (Resolve-Path "${remotePath}").Path`,
    ].join('; ')

    const captureResult = await remoteToolCall(code, 'remote_execute_command', {
      command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
      timeout: 20000,
    }, 25_000)

    const resolvedPath = captureResult.trim().split('\n').pop()?.trim()
    if (!resolvedPath) throw new Error('遠端截圖路徑取得失敗')

    // Fetch the screenshot file as base64
    const base64Data = await remoteToolCall(code, 'remote_fetch_file', {
      path: resolvedPath,
    }, 30_000)

    // Parse the base64 response — remote_fetch_file returns JSON with base64 field
    let imageBase64: string
    try {
      const parsed = JSON.parse(base64Data) as { base64?: string; content?: string }
      imageBase64 = parsed.base64 ?? parsed.content ?? base64Data
    } catch {
      imageBase64 = base64Data
    }

    const imageBuffer = Buffer.from(imageBase64, 'base64')

    await ctx.replyWithPhoto(Input.fromBuffer(imageBuffer, 'screenshot.png'), {
      caption: '🖥️ 遠端桌面',
    })
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})

    // Cleanup remote temp file
    await remoteToolCall(code, 'remote_execute_command', {
      command: `del "${resolvedPath}" 2>nul`,
    }, 5_000).catch(() => {})
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 遠端截圖失敗: ${msg}`
    ).catch(() => {})
  }
}

export async function screenshotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/screenshot\s*/, '').trim().split(/\s+/)
  const firstArg = args[0] || ''

  // Check remote pairing
  const threadId = ctx.message?.message_thread_id
  const pairing = getPairing(chatId, threadId)
  const isRemotePaired = !!pairing?.connected
  const forceLocal = firstArg === 'local'

  // Remote mode: paired + not forcing local + not URL + not list
  if (isRemotePaired && !forceLocal && firstArg !== 'list' && firstArg !== 'ls') {
    // If it's a URL, still handle locally (web screenshot)
    const isUrl = firstArg.startsWith('http://') || firstArg.startsWith('https://')
    if (!isUrl) {
      const code = getCodeForChat(chatId, threadId)
      if (code) {
        await captureRemoteScreenshot(ctx, code)
        return
      }
    }
  }

  // Strip 'local' arg so rest of logic works
  const effectiveFirstArg = forceLocal ? (args[1] || '') : firstArg

  // /screenshot list — show available screens
  if (effectiveFirstArg === 'list' || effectiveFirstArg === 'ls') {
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
  const screenNum = /^[1-9]$/.test(effectiveFirstArg) ? parseInt(effectiveFirstArg, 10) : 0

  if (screenNum > 0 || !effectiveFirstArg) {
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
