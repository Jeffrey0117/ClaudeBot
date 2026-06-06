/**
 * /ig — Instagram automation (CDP engine, see ../vision/ig-cdp-flow.ts).
 *
 * Usage:
 *   /ig post <filename> <caption>           — post immediately
 *   /ig add <datetime> <filename> <caption> — schedule a post
 *   /ig list                                — show upcoming schedule
 *   /ig cancel <id>                         — cancel a scheduled post
 *   /ig history                             — show recent post results
 *   /ig templates                           — list saved templates (legacy)
 */

import type { BotContext } from '../../types/context.js'
import { join, resolve, relative, basename } from 'node:path'
import { stat, readdir, writeFile, mkdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { runIgCdpPost } from '../vision/ig-cdp-flow.js'
import { getPairing } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'
import { loadPokkitConfig, uploadToPokkit } from '../../utils/upload-executor.js'
import {
  addEntry,
  listSchedule,
  cancelEntry,
  getHistory,
  type IgScheduleEntry,
} from './ig-schedule-store.js'

// --- Constants ---

const TEMPLATES_DIR = join(process.cwd(), 'data', 'ig-templates')
export const IG_VIDEOS_DIR = process.env.IG_VIDEOS_DIR ?? 'C:\\Users\\jeffb\\Videos'

// --- Types ---

interface PostResult {
  readonly success: boolean
  readonly duration_s: number
  readonly error?: string
  readonly step?: string
}

// --- Path safety ---

/** Validate filename stays within IG_VIDEOS_DIR (prevent path traversal). */
function safeVideoPath(filename: string): string | null {
  const resolved = resolve(IG_VIDEOS_DIR, filename)
  const rel = relative(IG_VIDEOS_DIR, resolved)
  if (rel.startsWith('..') || rel.includes('..')) return null
  return resolved
}

// --- Public API ---

/** Save a template image (called from photo-handler). */
export async function saveIgTemplate(name: string, buffer: Buffer): Promise<void> {
  const safeName = name.replace(/[/\\]/g, '_').replace(/\.\./g, '_')
  await mkdir(TEMPLATES_DIR, { recursive: true })
  await writeFile(join(TEMPLATES_DIR, `${safeName}.png`), buffer)
}

/**
 * Post to IG via the CDP-controlled Chrome (DOM-based, resolution-independent).
 *
 * Routing — the CDP Chrome may live on a DIFFERENT machine than the bot:
 *   paired (chatId given)  → transfer media to the agent machine, then run
 *                            the CDP flow THERE via remote_ig_post
 *   not paired             → run the CDP flow on this machine
 *
 * Same PostResult contract as the old pyautogui engine, so ig-scheduler
 * keeps working unchanged. Exported for use by ig-scheduler.
 */
export async function runIgPostScript(
  filename: string,
  caption: string,
  chatId?: number,
): Promise<PostResult> {
  const fullPath = safeVideoPath(filename)
  if (!fullPath) {
    return { success: false, duration_s: 0, error: '無效的檔案路徑' }
  }

  const pairing = chatId !== undefined ? getPairing(chatId, undefined) : null
  if (pairing?.connected) {
    return runRemoteIgPost(pairing.code, fullPath, caption)
  }
  return runIgCdpPost(fullPath, caption)
}

/** Transfer limit for the relay (remote_push_file caps at 20MB). */
const RELAY_PUSH_LIMIT = 20 * 1024 * 1024
const REMOTE_PUSH_TIMEOUT_MS = 180_000
const REMOTE_IG_TIMEOUT_MS = 360_000 // CDP flow on the agent can take minutes

/**
 * Remote route: media lives on THIS machine, CDP Chrome on the agent machine.
 *   ≤20MB → push file through the relay → agent posts from local path
 *   >20MB → upload to pokkit → agent downloads from URL and posts
 */
async function runRemoteIgPost(
  code: string,
  fullPath: string,
  caption: string,
): Promise<PostResult> {
  const started = Date.now()
  const fail = (step: string, error: string): PostResult => ({
    success: false,
    duration_s: (Date.now() - started) / 1000,
    error,
    step,
  })

  const fileName = basename(fullPath)
  try {
    const stats = await stat(fullPath)

    let raw: string
    if (stats.size <= RELAY_PUSH_LIMIT) {
      // Relay push: lands under the agent's baseDir at ig-videos/<name>
      const base64 = (await readFile(fullPath)).toString('base64')
      const remotePath = `ig-videos/${fileName}`
      await remoteToolCall(code, 'remote_push_file', { path: remotePath, base64 }, REMOTE_PUSH_TIMEOUT_MS)
      raw = await remoteToolCall(code, 'remote_ig_post', { path: remotePath, caption }, REMOTE_IG_TIMEOUT_MS)
    } else {
      // Pokkit route: agent pulls from URL (no relay size pressure).
      // 1d auto-expiry — the file only exists to make the transfer.
      if (!loadPokkitConfig()) {
        return fail('upload_pokkit', `檔案 ${(stats.size / 1024 / 1024).toFixed(1)}MB 超過 relay 上限 20MB，且 POKKIT_API_KEY 未設定`)
      }
      const url = await uploadToPokkit(fullPath, { expiresIn: '1d' })
      raw = await remoteToolCall(code, 'remote_ig_post', { url, filename: fileName, caption }, REMOTE_IG_TIMEOUT_MS)
    }

    try {
      return JSON.parse(raw) as PostResult
    } catch {
      return fail('remote_ig_post', `agent 回傳非 JSON: ${raw.slice(0, 200)}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail('remote_transfer', msg)
  }
}

// --- Helpers ---

function generateId(): string {
  return randomBytes(4).toString('hex')
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m${s}s`
}

/** Parse arguments that may have quoted filename and caption. */
function parseFilenameAndCaption(input: string): { filename: string; caption: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1)
    if (endQuote === -1) return null
    const filename = trimmed.slice(1, endQuote)
    const caption = trimmed.slice(endQuote + 1).trim()
    if (!filename || !caption) return null
    return { filename, caption }
  }

  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return null
  return {
    filename: trimmed.slice(0, spaceIdx),
    caption: trimmed.slice(spaceIdx + 1).trim(),
  }
}

// --- Command handler ---

export async function igCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  const args = text.replace(/^\/ig\s*/i, '').trim()

  if (!args) {
    await ctx.reply(
      '📸 *Instagram 自動化*\n\n' +
      '*發文:*\n' +
      '`/ig post <filename> <caption>`\n\n' +
      '*排程:*\n' +
      '`/ig add <datetime> <filename> <caption>`\n' +
      '`/ig list` — 查看排程\n' +
      '`/ig cancel <id>` — 取消排程\n' +
      '`/ig history` — 最近發文紀錄\n\n' +
      '*檔案:*\n' +
      '`/ig ls [子資料夾]` — 列出 Videos 裡的影片',
      { parse_mode: 'Markdown' },
    )
    return
  }

  // --- /ig post ---
  if (args.startsWith('post ')) {
    const parsed = parseFilenameAndCaption(args.slice(5))
    if (!parsed) {
      await ctx.reply('用法: `/ig post <filename> <caption>`', { parse_mode: 'Markdown' })
      return
    }
    await runIgPost(ctx, parsed.filename, parsed.caption)
    return
  }

  // --- /ig add ---
  if (args.startsWith('add ')) {
    await handleAddSchedule(ctx, args.slice(4).trim())
    return
  }

  // --- /ig list ---
  if (args === 'list') {
    await handleListSchedule(ctx)
    return
  }

  // --- /ig cancel ---
  if (args.startsWith('cancel ')) {
    await handleCancelSchedule(ctx, args.slice(7).trim())
    return
  }

  // --- /ig history ---
  if (args === 'history') {
    await handleHistory(ctx)
    return
  }

  // --- /ig ls [subdir] ---
  if (args === 'ls' || args.startsWith('ls ')) {
    await handleListVideos(ctx, args === 'ls' ? '' : args.slice(3).trim())
    return
  }

  // --- /ig templates (legacy) ---
  if (args === 'templates') {
    await listTemplates(ctx)
    return
  }

  await ctx.reply('無效指令，用 `/ig` 查看用法', { parse_mode: 'Markdown' })
}

// --- Post immediately ---

async function runIgPost(ctx: BotContext, filename: string, caption: string): Promise<void> {
  const chatId = ctx.chat!.id

  // Validate path safety
  const fullPath = safeVideoPath(filename)
  if (!fullPath) {
    await ctx.reply('❌ 無效的檔案路徑')
    return
  }

  // Verify file exists
  try {
    await stat(fullPath)
  } catch {
    await ctx.reply(`❌ 找不到檔案: ${filename}\n📁 目錄: ${IG_VIDEOS_DIR}`)
    return
  }

  const statusMsg = await ctx.reply(
    `📸 IG 發文中...\n📁 ${filename}\n✏️ ${caption.slice(0, 60)}${caption.length > 60 ? '...' : ''}`,
  )

  try {
    const result = await runIgPostScript(filename, caption, chatId)

    const statusText = result.success
      ? `✅ IG 發文成功！\n📁 ${filename}\n⏱ ${formatDuration(result.duration_s)}`
      : `❌ IG 發文失敗\n📁 ${filename}\n💥 ${result.error ?? 'Unknown error'}${result.step ? `\n📍 步驟: ${result.step}` : ''}`

    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, statusText)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ IG 發文異常: ${errMsg}`,
    )
  }
}

// --- Schedule commands ---

async function handleAddSchedule(ctx: BotContext, input: string): Promise<void> {
  // Format: <datetime> <filename> <caption>
  // datetime can be: 2025-04-15T14:00 or 2025-04-15 14:00
  const match = input.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})\s+(.+)$/)
  if (!match) {
    await ctx.reply(
      '用法: `/ig add <datetime> <filename> <caption>`\n\n' +
      '日期格式: `2025-04-15T14:00` 或 `2025-04-15 14:00`\n\n' +
      '範例:\n`/ig add 2025-04-15T14:00 video.mp4 今天的影片`',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const datetimeStr = match[1].replace(' ', 'T')
  const rest = match[2]
  const parsed = parseFilenameAndCaption(rest)
  if (!parsed) {
    await ctx.reply('❌ 無法解析 filename 和 caption')
    return
  }

  // Validate datetime
  const scheduled = new Date(datetimeStr)
  if (isNaN(scheduled.getTime())) {
    await ctx.reply('❌ 無效的日期格式')
    return
  }

  if (scheduled.getTime() <= Date.now()) {
    await ctx.reply('❌ 排程時間必須是未來')
    return
  }

  // Validate path safety
  const fullPath = safeVideoPath(parsed.filename)
  if (!fullPath) {
    await ctx.reply('❌ 無效的檔案路徑')
    return
  }

  // Verify file exists
  try {
    await stat(fullPath)
  } catch {
    await ctx.reply(`❌ 找不到檔案: ${parsed.filename}\n📁 目錄: ${IG_VIDEOS_DIR}`)
    return
  }

  const chatId = ctx.chat!.id
  const id = generateId()
  const entry: IgScheduleEntry = {
    id,
    chatId,
    datetime: datetimeStr,
    filename: parsed.filename,
    caption: parsed.caption,
    status: 'pending',
    createdAt: new Date().toISOString(),
    result: null,
  }

  addEntry(entry)

  await ctx.reply(
    `✅ 已排程 IG 發文\n\n` +
    `🆔 \`${id}\`\n` +
    `📅 ${datetimeStr.replace('T', ' ')}\n` +
    `📁 ${parsed.filename}\n` +
    `✏️ ${parsed.caption.slice(0, 60)}${parsed.caption.length > 60 ? '...' : ''}`,
    { parse_mode: 'Markdown' },
  )
}

async function handleListSchedule(ctx: BotContext): Promise<void> {
  const all = listSchedule()
  const pending = all.filter((e) => e.status === 'pending')

  if (pending.length === 0) {
    await ctx.reply('📋 目前沒有排程的 IG 發文')
    return
  }

  const sorted = [...pending].sort((a, b) => a.datetime.localeCompare(b.datetime))
  const lines = ['📋 *IG 排程列表*', '']
  for (const entry of sorted) {
    lines.push(
      `🆔 \`${entry.id}\` — ${entry.datetime.replace('T', ' ')}\n` +
      `📁 ${entry.filename}\n` +
      `✏️ ${entry.caption.slice(0, 40)}${entry.caption.length > 40 ? '...' : ''}`,
    )
    lines.push('')
  }
  lines.push(`用 \`/ig cancel <id>\` 取消`)

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

async function handleCancelSchedule(ctx: BotContext, id: string): Promise<void> {
  if (!id) {
    await ctx.reply('用法: `/ig cancel <id>`', { parse_mode: 'Markdown' })
    return
  }

  if (cancelEntry(id)) {
    await ctx.reply(`✅ 已取消排程 \`${id}\``, { parse_mode: 'Markdown' })
  } else {
    await ctx.reply(`❌ 找不到排程 \`${id}\`（可能已執行或不存在）`, { parse_mode: 'Markdown' })
  }
}

async function handleHistory(ctx: BotContext): Promise<void> {
  const history = getHistory()

  if (history.length === 0) {
    await ctx.reply('📜 還沒有 IG 發文紀錄')
    return
  }

  const lines = ['📜 *IG 發文紀錄* (最近 20 筆)', '']
  for (const entry of history) {
    const icon = entry.status === 'done' ? '✅' : '❌'
    const duration = entry.result?.duration_s
      ? ` (${formatDuration(entry.result.duration_s)})`
      : ''
    const error = entry.result?.error ? `\n  💥 ${entry.result.error}` : ''
    lines.push(`${icon} ${entry.datetime.replace('T', ' ')} — ${entry.filename}${duration}${error}`)
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

// --- List videos in IG_VIDEOS_DIR ---

const MEDIA_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.jpg', '.jpeg', '.png'])
const LS_LIMIT = 20

async function handleListVideos(ctx: BotContext, subdir: string): Promise<void> {
  const dirPath = subdir ? safeVideoPath(subdir) : IG_VIDEOS_DIR
  if (!dirPath) {
    await ctx.reply('❌ 無效的資料夾路徑')
    return
  }

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    await ctx.reply(`❌ 找不到資料夾: ${subdir || IG_VIDEOS_DIR}`)
    return
  }

  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const mediaFiles = entries.filter(
    (e) => e.isFile() && MEDIA_EXTS.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase()),
  )

  // Newest first — the file you just produced is the one you want to post
  const withTimes = await Promise.all(
    mediaFiles.map(async (e) => {
      const s = await stat(join(dirPath, e.name)).catch(() => null)
      return { name: e.name, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
    }),
  )
  const sorted = [...withTimes].sort((a, b) => b.mtime - a.mtime)
  const shown = sorted.slice(0, LS_LIMIT)

  // Markdown safety: filenames like 翻譯專案_xxx contain `_` which Telegram
  // parses as italic → "can't parse entities" 400. Everything user-derived
  // goes inside backtick code entities (where _ * [ are inert).
  const prefix = subdir ? `${subdir.replace(/\\/g, '/')}/` : ''
  const lines = [`📁 \`${subdir || 'Videos'}\``, '']

  if (folders.length > 0) {
    lines.push(...folders.map((f) => `📂 \`/ig ls ${prefix}${f}\``), '')
  }

  if (shown.length === 0) {
    lines.push('(沒有影片/圖片)')
  } else {
    // Stay under Telegram's 4096-char message cap (leave room for footer)
    const MAX_CHARS = 3800
    let used = lines.join('\n').length
    let displayed = 0
    for (const f of shown) {
      const mb = (f.size / 1024 / 1024).toFixed(1)
      const quoted = f.name.includes(' ') || prefix.includes(' ')
        ? `"${prefix}${f.name}"`
        : `${prefix}${f.name}`
      const block = `🎬 \`${f.name}\` (${mb}MB)\n   \`/ig post ${quoted} \``
      if (used + block.length > MAX_CHARS) break
      lines.push(block)
      used += block.length + 1
      displayed++
    }
    if (sorted.length > displayed) {
      lines.push('', `(還有 ${sorted.length - displayed} 個，只顯示最新 ${displayed})`)
    }
  }

  lines.push('', '點指令複製 → 補上文案送出')
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

// --- Legacy templates list ---

async function listTemplates(ctx: BotContext): Promise<void> {
  try {
    const files = await readdir(TEMPLATES_DIR)
    const pngs = files.filter((f) => f.endsWith('.png'))
    if (pngs.length === 0) {
      await ctx.reply('📂 尚無範本')
      return
    }
    await ctx.reply(`📂 範本 (${pngs.length}):\n${pngs.map((f) => `  ${f}`).join('\n')}`)
  } catch {
    await ctx.reply('📂 尚無範本')
  }
}
