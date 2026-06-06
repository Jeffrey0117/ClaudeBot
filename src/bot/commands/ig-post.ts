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
import { join, resolve, relative } from 'node:path'
import { stat, readdir, writeFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { runIgCdpPost } from '../vision/ig-cdp-flow.js'
import {
  addEntry,
  listSchedule,
  cancelEntry,
  getHistory,
  type IgScheduleEntry,
} from './ig-schedule-store.js'

// --- Constants ---

const TEMPLATES_DIR = join(process.cwd(), 'data', 'ig-templates')
const VIDEOS_DIR = process.env.IG_VIDEOS_DIR ?? 'C:\\Users\\jeffb\\Videos'

// --- Types ---

interface PostResult {
  readonly success: boolean
  readonly duration_s: number
  readonly error?: string
  readonly step?: string
}

// --- Path safety ---

/** Validate filename stays within VIDEOS_DIR (prevent path traversal). */
function safeVideoPath(filename: string): string | null {
  const resolved = resolve(VIDEOS_DIR, filename)
  const rel = relative(VIDEOS_DIR, resolved)
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
 * Replaces the old pyautogui ig-post-flow.py engine — same PostResult contract,
 * so ig-scheduler keeps working unchanged. Exported for use by ig-scheduler.
 */
export async function runIgPostScript(filename: string, caption: string): Promise<PostResult> {
  const fullPath = safeVideoPath(filename)
  if (!fullPath) {
    return { success: false, duration_s: 0, error: '無效的檔案路徑' }
  }
  return runIgCdpPost(fullPath, caption)
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
      '`/ig history` — 最近發文紀錄',
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
    await ctx.reply(`❌ 找不到檔案: ${filename}\n📁 目錄: ${VIDEOS_DIR}`)
    return
  }

  const statusMsg = await ctx.reply(
    `📸 IG 發文中...\n📁 ${filename}\n✏️ ${caption.slice(0, 60)}${caption.length > 60 ? '...' : ''}`,
  )

  try {
    const result = await runIgPostScript(filename, caption)

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
    await ctx.reply(`❌ 找不到檔案: ${parsed.filename}\n📁 目錄: ${VIDEOS_DIR}`)
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
