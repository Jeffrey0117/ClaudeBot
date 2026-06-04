import type { BotContext } from '../../types/context.js'
import { getPairingByLabel } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

/**
 * Remote-ops command pool: thin, deterministic wrappers around the remote_*
 * agent tools — instant + zero AI cost (no opus reasoning), exposed so natural
 * language can map to them via @cmd. Sibling family of /fabric + /bootstrap.
 */

interface Resolved {
  readonly code: string
  readonly label: string
  readonly rest: string
}

/** Parse "<machine> <rest...>" from the command text and resolve the pairing. */
function resolve(ctx: BotContext, cmdName: string): Resolved | { error: string } {
  const chatId = ctx.chat?.id
  if (!chatId) return { error: 'no chat' }
  const threadId = ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = raw.replace(new RegExp(`^/${cmdName}\\s*`), '').trim()
  const sp = args.indexOf(' ')
  const label = sp === -1 ? args : args.slice(0, sp)
  const rest = sp === -1 ? '' : args.slice(sp + 1).trim()

  if (!label) return { error: `用法: \`/${cmdName} <機器> ...\`（\`/machines\` 看 label）` }

  const pairing = getPairingByLabel(chatId, threadId, label)
  if (!pairing || !pairing.connected) return { error: `❌ 機器未連線: ${label}` }
  return { code: pairing.code, label, rest }
}

/** /ron <machine> <app> [args] — open a GUI app on the remote (visible, instant). */
export async function ronCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'ron')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/ron <機器> <app>`\n例: `/ron laptop mspaint`', { parse_mode: 'Markdown' }); return }

  const parts = r.rest.split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1)
  try {
    await remoteToolCall(r.code, 'remote_spawn_detached', { command, args: JSON.stringify(args) }, 20_000)
    await ctx.reply(`🚀 ${r.label}: 已開啟 ${command}（視窗應出現在該機器桌面）`)
  } catch (err) {
    await ctx.reply(`⚠️ 開啟失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rx <machine> <cmd> — run a command on the remote and return its output. */
export async function rxCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rx')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/rx <機器> <指令>`\n例: `/rx laptop dir`', { parse_mode: 'Markdown' }); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_execute_command', { command: r.rest }, 120_000)
    await ctx.reply(`💻 ${r.label} > ${r.rest}\n\n${out.slice(0, 3500) || '(無輸出)'}`)
  } catch (err) {
    await ctx.reply(`⚠️ 執行失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rstat <machine> — remote system info (disk / memory / network). */
export async function rstatCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rstat')
  if ('error' in r) { await ctx.reply(r.error); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_system_info', {}, 30_000)
    await ctx.reply(`📊 ${r.label}\n\n${out.slice(0, 3500)}`)
  } catch (err) {
    await ctx.reply(`⚠️ 取得狀態失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /ropen <machine> <url> — open a URL in the remote's default browser. */
export async function ropenCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'ropen')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/ropen <機器> <url>`', { parse_mode: 'Markdown' }); return }
  const url = r.rest.split(/\s+/)[0]
  try {
    // `start "" "<url>"` returns immediately (no timeout hang) and opens visibly.
    await remoteToolCall(r.code, 'remote_execute_command', { command: `start "" "${url}"` }, 20_000)
    await ctx.reply(`🌐 ${r.label}: 已開啟 ${url}`)
  } catch (err) {
    await ctx.reply(`⚠️ 開啟失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rkill <machine> <name|pid> — kill a process on the remote. */
export async function rkillCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rkill')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/rkill <機器> <程式名|PID>`', { parse_mode: 'Markdown' }); return }
  const target = r.rest.split(/\s+/)[0]
  const cmd = /^\d+$/.test(target) ? `taskkill /f /pid ${target}` : `taskkill /f /im "${target}"`
  try {
    const out = await remoteToolCall(r.code, 'remote_execute_command', { command: cmd }, 30_000)
    await ctx.reply(`🔪 ${r.label}: ${out.slice(0, 300) || '已送出'}`)
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rpower <machine> <lock|sleep|reboot|shutdown|cancel> */
export async function rpowerCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rpower')
  if ('error' in r) { await ctx.reply(r.error); return }
  const action = r.rest.split(/\s+/)[0]?.toLowerCase()
  const map: Record<string, string> = {
    lock: 'rundll32.exe user32.dll,LockWorkStation',
    sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
    reboot: 'shutdown /r /t 0',
    shutdown: 'shutdown /s /t 5',
    cancel: 'shutdown /a',
  }
  const cmd = map[action]
  if (!cmd) { await ctx.reply('用法: `/rpower <機器> <lock|sleep|reboot|shutdown|cancel>`', { parse_mode: 'Markdown' }); return }
  try {
    await remoteToolCall(r.code, 'remote_execute_command', { command: cmd }, 20_000)
    await ctx.reply(`⚡ ${r.label}: ${action}`)
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rpull <machine> <dir> — git pull a repo on the remote. */
export async function rpullCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rpull')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/rpull <機器> <專案目錄>`', { parse_mode: 'Markdown' }); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_execute_command', { command: `cd /d "${r.rest}" && git pull` }, 120_000)
    await ctx.reply(`🔄 ${r.label} > ${r.rest}\n\n${out.slice(0, 2000) || '(無輸出)'}`)
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rclip <machine> [text] — read (no text) or write (with text) the remote clipboard. */
export async function rclipCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rclip')
  if ('error' in r) { await ctx.reply(r.error); return }
  try {
    if (r.rest) {
      await remoteToolCall(r.code, 'remote_clipboard', { action: 'write', text: r.rest }, 20_000)
      await ctx.reply(`📋 ${r.label}: 已寫入剪貼簿`)
    } else {
      const out = await remoteToolCall(r.code, 'remote_clipboard', { action: 'read' }, 20_000)
      await ctx.reply(`📋 ${r.label} 剪貼簿:\n\n${out.slice(0, 3000) || '(空)'}`)
    }
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rnotify <machine> <msg> — desktop notification on the remote. */
export async function rnotifyCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rnotify')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/rnotify <機器> <訊息>`', { parse_mode: 'Markdown' }); return }
  try {
    await remoteToolCall(r.code, 'remote_notify', { title: 'ClaudeBot', body: r.rest }, 20_000)
    await ctx.reply(`🔔 ${r.label}: 已通知`)
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rls <machine> [path] — list a directory on the remote. */
export async function rlsCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rls')
  if ('error' in r) { await ctx.reply(r.error); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_list_directory', { path: r.rest || '.' }, 30_000)
    await ctx.reply(`📂 ${r.label}:${r.rest || '.'}\n\n${out.slice(0, 3500)}`)
  } catch (err) {
    await ctx.reply(`⚠️ 失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rshot <machine> — screenshot the remote's primary screen and send it back. */
export async function rshotCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rshot')
  if ('error' in r) { await ctx.reply(r.error); return }
  // Capture to a temp PNG and echo the absolute path back.
  const ps = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; '
    + '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; '
    + '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; '
    + '$g=[System.Drawing.Graphics]::FromImage($bmp); '
    + '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); '
    + '$p=Join-Path $env:TEMP \'rshot.png\'; $bmp.Save($p); Write-Output $p"'
  try {
    await ctx.reply(`📸 ${r.label}: 截圖中…`)
    const pathOut = await remoteToolCall(r.code, 'remote_execute_command', { command: ps }, 30_000)
    const path = pathOut.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (!/rshot\.png/i.test(path)) { await ctx.reply('⚠️ 截圖失敗(找不到輸出檔)'); return }
    const fetched = await remoteToolCall(r.code, 'remote_fetch_file', { path }, 60_000)
    const data = JSON.parse(fetched) as { base64?: string }
    if (!data.base64) { await ctx.reply('⚠️ 截圖失敗(無資料)'); return }
    await ctx.replyWithPhoto({ source: Buffer.from(data.base64, 'base64') }, { caption: `📸 ${r.label}` })
  } catch (err) {
    await ctx.reply(`⚠️ 截圖失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}
