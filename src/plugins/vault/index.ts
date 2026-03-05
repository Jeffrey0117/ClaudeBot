/**
 * Vault Plugin
 *
 * Telegram 訊息索引引擎。
 * 背景靜默記錄所有訊息的 metadata，提供搜尋、統計、標記功能。
 * 支援上下文回溯、訊息轉發、對話摘要。
 *
 * Commands:
 *   /vault          — 搜尋歷史訊息
 *   /vault stats    — 統計（總數、類型分佈）
 *   /vault recent   — 最近 N 則訊息
 *   /vault tag ID TAG — 給訊息加標記
 *   /vault voice    — 列出語音訊息
 *   /vault inject [N|keyword] — 上下文回溯注入
 *   /vault fwd ID   — 轉發指定訊息
 *   /vault summary  — 對話摘要
 */

import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { indexMessage } from './message-indexer.js'
import {
  searchEntries,
  getStats,
  getRecentEntries,
  getEntriesByTag,
  getEntriesByTimeRange,
  getRecentTextPreviews,
  addTag,
  getVoiceEntries,
  getEntryById,
} from './index-store.js'
import type { IndexEntry } from './index-store.js'
import { getUserState } from '../../bot/state.js'
import { enqueue } from '../../claude/queue.js'
import { getAISessionId } from '../../ai/session-store.js'
import { resolveBackend } from '../../ai/types.js'
import { getThreadId } from '../../utils/callback-helpers.js'
import { getPairing } from '../../remote/pairing-store.js'

// --- Formatters ---

function formatEntry(e: IndexEntry, showId: boolean = true): string {
  const time = new Date(e.timestamp).toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const icon = e.fromBot ? '🤖' : '👤'
  const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
  const id = showId ? `#${e.messageId} ` : ''
  return `${id}${icon} ${time} — ${e.preview}${tags}`
}

function formatTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    text: '💬', voice: '🎤', photo: '🖼', document: '📄',
    video: '🎬', sticker: '😀', other: '❓',
  }
  return icons[type] ?? '❓'
}

// --- Command handler ---

async function vaultCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/vault\s*/, '').trim()
  const chatId = ctx.chat!.id

  // /vault stats
  if (args === 'stats' || args === '統計') {
    return handleStats(ctx, chatId)
  }

  // /vault recent [N]
  if (args.startsWith('recent') || args.startsWith('最近')) {
    return handleRecent(ctx, chatId, args)
  }

  // /vault voice
  if (args === 'voice' || args === '語音') {
    return handleVoice(ctx, chatId)
  }

  // /vault tag ID TAG
  if (args.startsWith('tag ')) {
    return handleTag(ctx, chatId, args)
  }

  // /vault inject [N|keyword]
  if (args.startsWith('inject') || args.startsWith('回溯') || args.startsWith('注入')) {
    return handleInject(ctx, chatId, args)
  }

  // /vault fwd ID
  if (args.startsWith('fwd ') || args.startsWith('轉發 ')) {
    return handleForward(ctx, chatId, args)
  }

  // /vault summary [today|N]
  if (args.startsWith('summary') || args.startsWith('摘要')) {
    return handleSummary(ctx, chatId, args)
  }

  // /vault #TAG
  if (args.startsWith('#')) {
    return handleTagSearch(ctx, chatId, args)
  }

  // /vault KEYWORD — full text search
  if (args) {
    return handleSearch(ctx, chatId, args)
  }

  // /vault — no args, show help
  await ctx.reply(
    `🗄 *Vault — 訊息索引*\n\n` +
    `\`/vault 關鍵字\` — 搜尋訊息\n` +
    `\`/vault stats\` — 統計\n` +
    `\`/vault recent [N]\` — 最近 N 則\n` +
    `\`/vault voice\` — 語音訊息\n` +
    `\`/vault tag ID 標記\` — 加標記\n` +
    `\`/vault #標記\` — 依標記搜尋\n` +
    `\`/vault inject [N|關鍵字]\` — 回溯上下文\n` +
    `\`/vault fwd ID\` — 轉發訊息\n` +
    `\`/vault summary [today|N]\` — 對話摘要`,
    { parse_mode: 'Markdown' },
  )
}

// --- Sub-handlers ---

async function handleStats(ctx: BotContext, chatId: number): Promise<void> {
  const stats = getStats(chatId)

  if (stats.total === 0) {
    await ctx.reply('📊 尚無索引資料（從啟用 vault 開始記錄）')
    return
  }

  const typeLines = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `  ${formatTypeIcon(type)} ${type}: ${count}`)

  const oldest = stats.oldest ? new Date(stats.oldest).toLocaleDateString('zh-TW') : '-'
  const newest = stats.newest ? new Date(stats.newest).toLocaleDateString('zh-TW') : '-'

  await ctx.reply(
    `📊 *Vault 統計*\n\n` +
    `總訊息: ${stats.total}\n` +
    `已標記: ${stats.tagged}\n` +
    `期間: ${oldest} → ${newest}\n\n` +
    `*類型分佈:*\n${typeLines.join('\n')}`,
    { parse_mode: 'Markdown' },
  )
}

async function handleRecent(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const n = parseInt(args.split(/\s+/)[1] ?? '10', 10)
  const limit = Math.min(Math.max(n, 1), 30)
  const entries = getRecentEntries(chatId, limit)

  if (entries.length === 0) {
    await ctx.reply('📭 尚無索引資料')
    return
  }

  const lines = entries.map(e => formatEntry(e))
  await ctx.reply(
    `📋 *最近 ${entries.length} 則*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' },
  ).catch(() => ctx.reply(`📋 最近 ${entries.length} 則\n\n${lines.join('\n')}`))
}

async function handleVoice(ctx: BotContext, chatId: number): Promise<void> {
  const entries = getVoiceEntries(chatId, 20)

  if (entries.length === 0) {
    await ctx.reply('🎤 沒有語音訊息紀錄')
    return
  }

  const lines = entries.map(e => formatEntry(e))
  await ctx.reply(
    `🎤 *語音訊息 (${entries.length})*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' },
  ).catch(() => ctx.reply(`🎤 語音訊息 (${entries.length})\n\n${lines.join('\n')}`))
}

async function handleTag(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const parts = args.split(/\s+/)
  const msgId = parseInt(parts[1] ?? '', 10)
  const tag = parts.slice(2).join(' ')

  if (isNaN(msgId) || !tag) {
    await ctx.reply('💡 用法: `/vault tag 12345 重要`', { parse_mode: 'Markdown' })
    return
  }

  const success = addTag(chatId, msgId, tag)
  if (success) {
    await ctx.reply(`🏷 已標記 #${msgId}: \`${tag}\``, { parse_mode: 'Markdown' })
  } else {
    await ctx.reply(`❌ 找不到訊息 #${msgId}`)
  }
}

async function handleTagSearch(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const tag = args.slice(1)
  const entries = getEntriesByTag(chatId, tag)

  if (entries.length === 0) {
    await ctx.reply(`🏷 沒有標記 \`${tag}\` 的訊息`, { parse_mode: 'Markdown' })
    return
  }

  const lines = entries.map(e => formatEntry(e))
  await ctx.reply(
    `🏷 *標記: ${tag}* (${entries.length})\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' },
  ).catch(() => ctx.reply(`🏷 標記: ${tag} (${entries.length})\n\n${lines.join('\n')}`))
}

async function handleSearch(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const entries = searchEntries(chatId, args)

  if (entries.length === 0) {
    await ctx.reply(`🔍 找不到包含「${args}」的訊息`)
    return
  }

  const shown = entries.slice(-20)
  const lines = shown.map(e => formatEntry(e))
  const moreText = entries.length > 20 ? `\n\n_(還有 ${entries.length - 20} 則)_` : ''
  await ctx.reply(
    `🔍 *搜尋: ${args}* (${entries.length})\n\n${lines.join('\n')}${moreText}`,
    { parse_mode: 'Markdown' },
  ).catch(() => ctx.reply(`🔍 搜尋: ${args} (${entries.length})\n\n${lines.join('\n')}${moreText}`))
}

// --- 🔥 Killer features ---

/**
 * /vault inject [N|keyword]
 * Recall messages and inject into AI context.
 *
 * - inject 20       → last 20 messages as context
 * - inject cloudpipe → search and inject relevant messages
 */
async function handleInject(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const param = args.replace(/^(inject|回溯|注入)\s*/, '').trim()
  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
    ?? (getPairing(chatId, threadId)?.connected ? { name: 'remote', path: process.cwd() } : null)

  if (!project) {
    await ctx.reply('❌ 尚未選擇專案')
    return
  }

  let entries: readonly IndexEntry[]
  let label: string

  // Number → recent N messages
  const n = parseInt(param, 10)
  if (!isNaN(n) && n > 0) {
    entries = getRecentTextPreviews(chatId, Math.min(n, 50))
    label = `最近 ${entries.length} 則`
  } else if (param) {
    // Keyword search
    entries = searchEntries(chatId, param).slice(-30)
    label = `搜尋「${param}」${entries.length} 則`
  } else {
    // Default: last 15
    entries = getRecentTextPreviews(chatId, 15)
    label = `最近 ${entries.length} 則`
  }

  if (entries.length === 0) {
    await ctx.reply('📭 找不到可回溯的訊息')
    return
  }

  // Build context block
  const contextLines = entries.map(e => {
    const who = e.fromBot ? 'Bot' : 'User'
    const time = new Date(e.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    return `[${time}] ${who}: ${e.preview}`
  })

  const contextBlock =
    `[對話回溯 — ${label}]\n` +
    contextLines.join('\n') +
    `\n[/對話回溯]\n\n` +
    `以上是之前的對話紀錄，請參考這些上下文繼續回答。`

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  enqueue({
    chatId,
    prompt: contextBlock,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  await ctx.reply(`🔄 已回溯 ${entries.length} 則訊息注入 AI 上下文`)
}

/**
 * /vault fwd ID [ID2 ID3 ...]
 * Forward messages back to chat by message ID.
 */
async function handleForward(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const ids = args.replace(/^(fwd|轉發)\s*/, '').trim().split(/[\s,]+/)
    .map(s => parseInt(s.replace('#', ''), 10))
    .filter(n => !isNaN(n))

  if (ids.length === 0) {
    await ctx.reply('💡 用法: `/vault fwd 12345` 或 `/vault fwd 123 456 789`', { parse_mode: 'Markdown' })
    return
  }

  let forwarded = 0
  let failed = 0

  for (const msgId of ids) {
    try {
      await ctx.telegram.forwardMessage(chatId, chatId, msgId)
      forwarded++
    } catch {
      // Message might have been deleted or too old
      const entry = getEntryById(chatId, msgId)
      if (entry) {
        // Fallback: send the preview text
        await ctx.reply(`📌 #${msgId}: ${entry.preview}`)
        forwarded++
      } else {
        failed++
      }
    }
  }

  if (failed > 0) {
    await ctx.reply(`✅ 轉發 ${forwarded} 則，❌ ${failed} 則失敗（可能已刪除）`)
  }
}

/**
 * /vault summary [today|N]
 * Generate conversation summary and send to AI for processing.
 *
 * - summary        → today's messages
 * - summary today  → today's messages
 * - summary 50     → last 50 messages
 */
async function handleSummary(ctx: BotContext, chatId: number, args: string): Promise<void> {
  const param = args.replace(/^(summary|摘要)\s*/, '').trim()
  const threadId = getThreadId(ctx)
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
    ?? (getPairing(chatId, threadId)?.connected ? { name: 'remote', path: process.cwd() } : null)

  if (!project) {
    await ctx.reply('❌ 尚未選擇專案')
    return
  }

  let entries: readonly IndexEntry[]
  let label: string

  const n = parseInt(param, 10)
  if (!isNaN(n) && n > 0) {
    entries = getRecentEntries(chatId, Math.min(n, 100))
    label = `最近 ${entries.length} 則`
  } else {
    // Default: today
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    entries = getEntriesByTimeRange(chatId, todayStart.getTime())
    label = entries.length > 0 ? `今天 ${entries.length} 則` : '最近 30 則'

    // Fallback to last 30 if no messages today
    if (entries.length === 0) {
      entries = getRecentEntries(chatId, 30)
    }
  }

  if (entries.length === 0) {
    await ctx.reply('📭 沒有訊息可以摘要')
    return
  }

  // Build conversation for AI
  const convoLines = entries.map(e => {
    const who = e.fromBot ? 'Bot' : 'User'
    const time = new Date(e.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    const typeTag = e.type !== 'text' ? ` [${e.type}]` : ''
    return `[${time}] ${who}${typeTag}: ${e.preview}`
  })

  const summaryPrompt =
    `請幫我摘要以下對話（${label}）。\n` +
    `重點整理：\n` +
    `1. 討論了什麼主題\n` +
    `2. 做了什麼決定\n` +
    `3. 完成了什麼\n` +
    `4. 還有什麼待辦\n\n` +
    `--- 對話紀錄 ---\n` +
    convoLines.join('\n') +
    `\n--- 結束 ---`

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  enqueue({
    chatId,
    prompt: summaryPrompt,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  await ctx.reply(`📝 正在摘要 ${entries.length} 則訊息...`)
}

// --- Plugin ---

const vaultPlugin: Plugin = {
  name: 'vault',
  description: '訊息索引引擎 (搜尋/回溯/摘要/轉發)',
  commands: [
    { name: 'vault', description: '訊息索引 (搜尋/stats/inject/fwd/summary)', handler: vaultCommand },
  ],
  onMessage: indexMessage,
}

export default vaultPlugin
