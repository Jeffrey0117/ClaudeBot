import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { resolve } from 'node:path'
import { Markup } from 'telegraf'
import { createJsonFileStore } from '../../utils/json-file-store.js'
import { addPin } from '../../bot/context-pin-store.js'
import { getUserState } from '../../bot/state.js'
import { getThreadId } from '../../utils/callback-helpers.js'
import { enqueue } from '../../claude/queue.js'
import { getAISessionId } from '../../ai/session-store.js'
import { resolveBackend } from '../../ai/types.js'
import { getPairing } from '../../remote/pairing-store.js'

// --- Clip storage (bookmark layer) ---

interface ClipEntry {
  readonly name: string
  readonly text: string
  readonly project: string
  readonly savedAt: number
}

type ClipData = Record<string, ClipEntry[]>  // keyed by chatId

const MAX_CLIPS = 20
const store = createJsonFileStore<ClipData>(resolve('data/clips.json'), () => ({}))

function getClips(chatId: number): readonly ClipEntry[] {
  return store.load()[String(chatId)] ?? []
}

function addClip(chatId: number, entry: ClipEntry): boolean {
  const data = store.load()
  const key = String(chatId)
  const list = [...(data[key] ?? [])]

  const existIdx = list.findIndex(c => c.name === entry.name)
  if (existIdx >= 0) {
    list[existIdx] = entry
  } else {
    if (list.length >= MAX_CLIPS) {
      list.shift()
    }
    list.push(entry)
  }

  store.save({ ...data, [key]: list })
  return true
}

function removeClip(chatId: number, name: string): boolean {
  const data = store.load()
  const key = String(chatId)
  const list = data[key] ?? []
  const filtered = list.filter(c => c.name !== name)

  if (filtered.length === list.length) return false

  store.save({ ...data, [key]: filtered })
  return true
}

// --- Pending save: temporarily hold text until user picks a mode ---

interface PendingSave {
  readonly text: string
  readonly name: string
  readonly messageId: number
}

const pendingSaves = new Map<number, PendingSave>()  // chatId → pending

// --- /save — unified entry point ---

async function saveCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/save\s*/, '').trim()

  const reply = ctx.message && 'reply_to_message' in ctx.message
    ? ctx.message.reply_to_message
    : null

  if (!reply) {
    await ctx.reply(
      '💡 *存訊息*\n\n' +
      '回覆一條訊息並打 `/save` 或 `/save 名稱`\n' +
      '會出現選項讓你選存到哪裡：\n\n' +
      '📌 **書籤** — `/recall` 叫回\n' +
      '📎 **釘選** — 每次 prompt 自動注入\n' +
      '🧠 **AI 記憶** — AI 摘要存入知識庫',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const text = reply && 'text' in reply ? reply.text ?? '' : ''
  if (!text) {
    await ctx.reply('❌ 該訊息沒有文字內容')
    return
  }

  const clipName = name || `clip-${Date.now().toString(36)}`
  const msgId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0

  // Store pending and show options
  pendingSaves.set(ctx.chat!.id, { text, name: clipName, messageId: msgId })

  const preview = text.slice(0, 60).replace(/\n/g, ' ')
  const previewText = text.length > 60 ? `${preview}...` : preview

  await ctx.reply(
    `💾 要把這段存到哪裡？\n\n> ${previewText}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📌 書籤', `save_mode:clip:${clipName}`),
          Markup.button.callback('📎 釘選', `save_mode:pin:${clipName}`),
        ],
        [
          Markup.button.callback('🧠 AI 記憶', `save_mode:mem:${clipName}`),
        ],
      ]),
    },
  )
}

// --- Callback handler ---

async function handleCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('save_mode:')) return false

  const chatId = ctx.chat!.id
  const parts = data.split(':')
  const mode = parts[1]  // clip | pin | mem
  const name = parts.slice(2).join(':') || 'unnamed'

  const pending = pendingSaves.get(chatId)
  if (!pending) {
    await ctx.answerCbQuery('已過期，請重新 /save')
    return true
  }

  pendingSaves.delete(chatId)
  const threadId = getThreadId(ctx)

  switch (mode) {
    case 'clip': {
      const project = getUserState(chatId, threadId).selectedProject?.name ?? ''
      addClip(chatId, {
        name,
        text: pending.text,
        project,
        savedAt: Date.now(),
      })
      await ctx.editMessageText(`📌 已存書籤: \`${name}\`\n用 \`/recall ${name}\` 叫回來`, { parse_mode: 'Markdown' })
      break
    }

    case 'pin': {
      const state = getUserState(chatId, threadId)
      const project = state.selectedProject
        ?? (getPairing(chatId, threadId)?.connected ? { name: 'remote', path: process.cwd() } : null)

      if (!project) {
        await ctx.editMessageText('❌ 尚未選擇專案，無法釘選')
        break
      }

      const pinResult = addPin(project.path, pending.text)
      if (!pinResult) {
        await ctx.editMessageText('❌ 釘選已達上限 (10)')
        break
      }

      await ctx.editMessageText(`📎 已釘選到 *${project.name}*\n每次 prompt 都會自動帶入`, { parse_mode: 'Markdown' })
      break
    }

    case 'mem': {
      const state = getUserState(chatId, threadId)
      const project = state.selectedProject
        ?? (getPairing(chatId, threadId)?.connected ? { name: 'remote', path: process.cwd() } : null)

      if (!project) {
        await ctx.editMessageText('❌ 尚未選擇專案，無法使用 AI 記憶')
        break
      }

      // Enqueue the text as a prompt with instruction to save via claude-mem
      const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
      const savePrompt = `請將以下內容摘要並存入記憶（用 claude-mem save）：\n\n${pending.text}`

      enqueue({
        chatId,
        prompt: savePrompt,
        project,
        ai: state.ai,
        sessionId,
        imagePaths: [],
      })

      await ctx.editMessageText('🧠 已送交 AI 摘要並存入知識庫')
      break
    }

    default:
      await ctx.answerCbQuery('未知模式')
  }

  await ctx.answerCbQuery().catch(() => {})
  return true
}

// --- /recall ---

async function recallCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/recall\s*/, '').trim()
  const chatId = ctx.chat!.id
  const clips = getClips(chatId)

  if (clips.length === 0) {
    await ctx.reply('📭 沒有書籤。回覆訊息並打 `/save` 來存', { parse_mode: 'Markdown' })
    return
  }

  if (!name) {
    const lines = clips.map((c, i) => {
      const date = new Date(c.savedAt).toLocaleDateString('zh-TW')
      const preview = c.text.slice(0, 40).replace(/\n/g, ' ')
      const proj = c.project ? ` [${c.project}]` : ''
      return `${i + 1}. \`${c.name}\`${proj} — ${preview}${c.text.length > 40 ? '...' : ''} _(${date})_`
    })
    await ctx.reply(`📋 *書籤 (${clips.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' })
    return
  }

  const clip = clips.find(c => c.name === name)
    ?? clips.find(c => c.name.includes(name))

  if (!clip) {
    await ctx.reply(`❌ 找不到 \`${name}\`\n用 \`/recall\` 查看所有書籤`, { parse_mode: 'Markdown' })
    return
  }

  const header = `📌 **${clip.name}**${clip.project ? ` [${clip.project}]` : ''}\n\n`
  await ctx.reply(header + clip.text, { parse_mode: 'Markdown' }).catch(() => {
    ctx.reply(header + clip.text)
  })
}

// --- /unsave ---

async function unsaveCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/unsave\s*/, '').trim()

  if (!name) {
    await ctx.reply('💡 用法：`/unsave 名稱`', { parse_mode: 'Markdown' })
    return
  }

  const removed = removeClip(ctx.chat!.id, name)
  if (removed) {
    await ctx.reply(`🗑 已刪除: \`${name}\``, { parse_mode: 'Markdown' })
  } else {
    await ctx.reply(`❌ 找不到 \`${name}\``, { parse_mode: 'Markdown' })
  }
}

const clipPlugin: Plugin = {
  name: 'clip',
  description: '統一記憶入口 (書籤/釘選/AI記憶)',
  commands: [
    { name: 'save', description: '存訊息 → 選存到哪', handler: saveCommand },
    { name: 'recall', description: '叫回書籤 (名稱)', handler: recallCommand },
    { name: 'unsave', description: '刪除書籤 (名稱)', handler: unsaveCommand },
  ],
  onCallback: handleCallback,
}

export default clipPlugin
