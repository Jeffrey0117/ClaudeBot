import { Markup } from 'telegraf'
import { Input } from 'telegraf'
import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import type { BrowserBackend, PageInfo } from './browser-backend.js'
import { isPinchtabAvailable, createPinchtabBackend } from './pinchtab-backend.js'
import { createPlaywrightBackend } from './playwright-backend.js'

const MAX_DISPLAY_TEXT = 800
const MAX_LINKS_DISPLAY = 10
const MAX_SESSIONS = 5
const SESSION_IDLE_MS = 10 * 60 * 1000 // 10 minutes

// --- SSRF protection ---
function isUrlSafe(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false
    if (hostname === '169.254.169.254') return false

    const parts = hostname.split('.').map(Number)
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      if (parts[0] === 10) return false
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false
      if (parts[0] === 192 && parts[1] === 168) return false
      if (parts[0] === 0) return false
    }

    return true
  } catch {
    return false
  }
}

// --- Session management with idle timeout + capacity limit ---
interface SessionEntry {
  readonly backend: BrowserBackend
  lastUsed: number
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<number, SessionEntry>()
const pageCache = new Map<number, PageInfo>()

// Backend detection — promise-based singleton (no TOCTOU race)
let detectionPromise: Promise<'pinchtab' | 'playwright'> | null = null

function detectBackend(): Promise<'pinchtab' | 'playwright'> {
  if (!detectionPromise) {
    detectionPromise = isPinchtabAvailable().then(
      (available) => available ? 'pinchtab' as const : 'playwright' as const,
    )
  }
  return detectionPromise
}

async function evictSession(chatId: number): Promise<void> {
  const entry = sessions.get(chatId)
  if (!entry) return
  clearTimeout(entry.timer)
  await entry.backend.cleanup().catch(() => {})
  sessions.delete(chatId)
  pageCache.delete(chatId)
}

async function getSession(chatId: number): Promise<BrowserBackend> {
  const existing = sessions.get(chatId)
  if (existing) {
    existing.lastUsed = Date.now()
    clearTimeout(existing.timer)
    existing.timer = setTimeout(() => { evictSession(chatId) }, SESSION_IDLE_MS)
    return existing.backend
  }

  // Evict oldest if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()]
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]
    if (oldest) await evictSession(oldest[0])
  }

  const backendType = await detectBackend()
  const backend = backendType === 'pinchtab'
    ? createPinchtabBackend()
    : createPlaywrightBackend()

  const timer = setTimeout(() => { evictSession(chatId) }, SESSION_IDLE_MS)
  sessions.set(chatId, { backend, lastUsed: Date.now(), timer })
  return backend
}

// --- Formatting helpers ---
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

function formatPageResponse(info: PageInfo): string {
  const domain = (() => {
    try { return new URL(info.url).hostname } catch { return info.url }
  })()
  const title = info.title || domain
  const text = truncateText(info.text.trim(), MAX_DISPLAY_TEXT)

  const lines = [`🌐 ${escapeMarkdown(domain)}`, '']
  if (title !== domain) lines.push(`*${escapeMarkdown(title)}*`, '')
  if (text) lines.push(escapeMarkdown(text))

  return lines.join('\n')
}

function buildPageKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔗 連結', 'browse:links'),
      Markup.button.callback('📸 截圖', 'browse:screenshot'),
      Markup.button.callback('🔄 重整', 'browse:refresh'),
    ],
    [
      Markup.button.callback('⬅️ 返回', 'browse:back'),
    ],
  ])
}

function buildLinksKeyboard(links: readonly { label: string; url: string }[]): ReturnType<typeof Markup.inlineKeyboard> {
  const displayed = links.slice(0, MAX_LINKS_DISPLAY)
  const rows = displayed.map((_, i) =>
    [Markup.button.callback(`${i + 1}`, `browse:click:${i}`)]
  )
  rows.push([Markup.button.callback('⬅️ 返回頁面', 'browse:page')])
  return Markup.inlineKeyboard(rows)
}

function validateNumericRef(ref: string): number {
  const index = parseInt(ref, 10)
  if (isNaN(index) || index < 0) {
    throw new Error('ref 必須是非負整數')
  }
  return index
}

// --- Command handlers ---
async function browseCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/browse\s*/, '').trim()

  if (!args) {
    await ctx.reply(
      '🌐 *互動式瀏覽器*\n\n'
      + '`/browse <url>` — 開啟網頁\n'
      + '`/browse click <N>` — 點擊連結\n'
      + '`/browse type <N> <text>` — 輸入文字\n'
      + '`/browse back` — 上一頁\n'
      + '`/browse screenshot` — 截圖',
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Sub-commands
  if (args.startsWith('click ')) {
    await handleClick(ctx, chatId, args.slice(6).trim())
    return
  }
  if (args.startsWith('type ')) {
    await handleType(ctx, chatId, args.slice(5).trim())
    return
  }
  if (args === 'back') {
    await handleBack(ctx, chatId)
    return
  }
  if (args === 'screenshot') {
    await handleScreenshot(ctx, chatId)
    return
  }

  // Navigate to URL
  let url = args
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`
  }

  if (!isUrlSafe(url)) {
    await ctx.reply('❌ 無法瀏覽此 URL（內部網路或不支援的協定）')
    return
  }

  const statusMsg = await ctx.reply('🌐 載入中...')

  try {
    const session = await getSession(chatId)
    const info = await session.navigate(url)
    pageCache.set(chatId, info)

    const text = formatPageResponse(info)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      text,
      { parse_mode: 'MarkdownV2', ...buildPageKeyboard() },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 載入失敗: ${msg}`,
    ).catch(() => {})
  }
}

async function handleClick(ctx: BotContext, chatId: number, ref: string): Promise<void> {
  if (!ref) {
    await ctx.reply('用法: `/browse click <N>`', { parse_mode: 'Markdown' })
    return
  }

  try {
    validateNumericRef(ref)
  } catch {
    await ctx.reply('❌ 請輸入連結編號（數字）')
    return
  }

  const statusMsg = await ctx.reply('🔗 點擊中...')

  try {
    const session = await getSession(chatId)
    const info = await session.click(ref)
    pageCache.set(chatId, info)

    const text = formatPageResponse(info)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      text,
      { parse_mode: 'MarkdownV2', ...buildPageKeyboard() },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 點擊失敗: ${msg}`,
    ).catch(() => {})
  }
}

async function handleType(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const spaceIdx = args.indexOf(' ')
  if (spaceIdx === -1) {
    await ctx.reply('用法: `/browse type <N> <text>`', { parse_mode: 'Markdown' })
    return
  }

  const ref = args.slice(0, spaceIdx)
  const text = args.slice(spaceIdx + 1)

  try {
    validateNumericRef(ref)
  } catch {
    await ctx.reply('❌ 請輸入欄位編號（數字）')
    return
  }

  const statusMsg = await ctx.reply('⌨️ 輸入中...')

  try {
    const session = await getSession(chatId)
    const info = await session.type(ref, text)
    pageCache.set(chatId, info)

    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `⌨️ 已輸入: ${text}`,
      buildPageKeyboard(),
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 輸入失敗: ${msg}`,
    ).catch(() => {})
  }
}

async function handleBack(ctx: BotContext, chatId: number): Promise<void> {
  const statusMsg = await ctx.reply('⬅️ 返回中...')

  try {
    const session = await getSession(chatId)
    const info = await session.back()
    pageCache.set(chatId, info)

    const text = formatPageResponse(info)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      text,
      { parse_mode: 'MarkdownV2', ...buildPageKeyboard() },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 返回失敗: ${msg}`,
    ).catch(() => {})
  }
}

async function handleScreenshot(ctx: BotContext, chatId: number): Promise<void> {
  const statusMsg = await ctx.reply('📸 截圖中...')

  try {
    const session = await getSession(chatId)
    const buffer = await session.screenshot()

    await ctx.replyWithPhoto(Input.fromBuffer(buffer, 'screenshot.png'), {
      caption: '📸 瀏覽器截圖',
    })
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 截圖失敗: ${msg}`,
    ).catch(() => {})
  }
}

// --- Callback handler ---
async function handleCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('browse:')) return false

  const chatId = ctx.chat?.id
  if (!chatId) return true

  const action = data.slice(7) // strip 'browse:'

  if (action === 'links') {
    const cached = pageCache.get(chatId)
    if (!cached || cached.links.length === 0) {
      await ctx.answerCbQuery('此頁面沒有連結')
      return true
    }

    const displayed = cached.links.slice(0, MAX_LINKS_DISPLAY)
    const lines = displayed.map((link, i) =>
      `${i + 1}\\. ${escapeMarkdown(link.label)}\n   ${escapeMarkdown(link.url)}`
    )

    await ctx.editMessageText(
      `🔗 *頁面連結*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'MarkdownV2', ...buildLinksKeyboard(displayed) },
    ).catch(() => {})
    await ctx.answerCbQuery()
    return true
  }

  if (action === 'screenshot') {
    await ctx.answerCbQuery('📸 截圖中...')
    try {
      const session = await getSession(chatId)
      const buffer = await session.screenshot()
      await ctx.replyWithPhoto(Input.fromBuffer(buffer, 'screenshot.png'), {
        caption: '📸 瀏覽器截圖',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.reply(`❌ 截圖失敗: ${msg}`)
    }
    return true
  }

  if (action === 'refresh') {
    await ctx.answerCbQuery('🔄 重新整理中...')
    try {
      const cached = pageCache.get(chatId)
      if (!cached) return true
      const session = await getSession(chatId)
      const info = await session.navigate(cached.url)
      pageCache.set(chatId, info)

      const text = formatPageResponse(info)
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...buildPageKeyboard(),
      }).catch(() => {})
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.reply(`❌ 重新整理失敗: ${msg}`)
    }
    return true
  }

  if (action === 'back') {
    await ctx.answerCbQuery('⬅️ 返回中...')
    try {
      const session = await getSession(chatId)
      const info = await session.back()
      pageCache.set(chatId, info)

      const text = formatPageResponse(info)
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...buildPageKeyboard(),
      }).catch(() => {})
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.reply(`❌ 返回失敗: ${msg}`)
    }
    return true
  }

  if (action === 'page') {
    const cached = pageCache.get(chatId)
    if (cached) {
      const text = formatPageResponse(cached)
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...buildPageKeyboard(),
      }).catch(() => {})
    }
    await ctx.answerCbQuery()
    return true
  }

  // browse:click:N
  if (action.startsWith('click:')) {
    const ref = action.slice(6)
    const index = parseInt(ref, 10)
    if (isNaN(index) || index < 0) {
      await ctx.answerCbQuery('❌ 無效的連結編號')
      return true
    }

    await ctx.answerCbQuery(`🔗 點擊 #${index + 1}...`)

    try {
      const session = await getSession(chatId)
      const info = await session.click(ref)
      pageCache.set(chatId, info)

      const text = formatPageResponse(info)
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...buildPageKeyboard(),
      }).catch(() => {})
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await ctx.reply(`❌ 點擊失敗: ${msg}`)
    }
    return true
  }

  return false
}

// --- Plugin definition ---
const browsePlugin: Plugin = {
  name: 'browse',
  description: '互動式網頁瀏覽器',
  commands: [
    {
      name: 'browse',
      description: '瀏覽網頁 (URL/click/type/back)',
      handler: browseCommand,
    },
  ],
  onCallback: handleCallback,
  cleanup: async () => {
    const cleanupPromises = [...sessions.values()].map((entry) =>
      entry.backend.cleanup().catch(() => {})
    )
    await Promise.all(cleanupPromises)
    for (const entry of sessions.values()) {
      clearTimeout(entry.timer)
    }
    sessions.clear()
    pageCache.clear()
    detectionPromise = null
  },
}

export default browsePlugin
