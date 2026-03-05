/**
 * Message Indexer
 *
 * Silent onMessage hook that records every incoming message's metadata.
 * Never consumes messages (always returns false).
 * Also indexes bot's own replies via a separate function.
 */

import type { BotContext } from '../../types/context.js'
import { addEntry } from './index-store.js'
import type { IndexEntry } from './index-store.js'

/**
 * Determine message type from Telegraf context.
 */
function getMessageType(msg: Record<string, unknown>): IndexEntry['type'] {
  if (msg.voice || msg.audio) return 'voice'
  if (msg.photo) return 'photo'
  if (msg.document) return 'document'
  if (msg.video || msg.video_note) return 'video'
  if (msg.sticker) return 'sticker'
  if (msg.text) return 'text'
  return 'other'
}

/**
 * Extract a short preview from the message.
 */
function getPreview(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string') {
    return msg.text.slice(0, 100).replace(/\n/g, ' ')
  }
  if (typeof msg.caption === 'string') {
    return msg.caption.slice(0, 100).replace(/\n/g, ' ')
  }
  if (msg.voice || msg.audio) return '[語音]'
  if (msg.photo) return '[圖片]'
  if (msg.document) {
    const doc = msg.document as { file_name?: string }
    return doc.file_name ? `[檔案] ${doc.file_name}` : '[檔案]'
  }
  if (msg.video) return '[影片]'
  if (msg.sticker) {
    const sticker = msg.sticker as { emoji?: string }
    return sticker.emoji ? `[貼圖] ${sticker.emoji}` : '[貼圖]'
  }
  return '[其他]'
}

/**
 * Extract file IDs for voice/documents/photos.
 */
function getFileId(msg: Record<string, unknown>): string | undefined {
  if (msg.document) {
    return (msg.document as { file_id?: string }).file_id
  }
  if (msg.photo) {
    const photos = msg.photo as Array<{ file_id: string }>
    return photos[photos.length - 1]?.file_id  // largest size
  }
  if (msg.video) {
    return (msg.video as { file_id?: string }).file_id
  }
  return undefined
}

function getVoiceFileId(msg: Record<string, unknown>): string | undefined {
  if (msg.voice) {
    return (msg.voice as { file_id?: string }).file_id
  }
  if (msg.audio) {
    return (msg.audio as { file_id?: string }).file_id
  }
  return undefined
}

/**
 * onMessage hook — silently index every message.
 * Always returns false (never consumes the message).
 */
export async function indexMessage(ctx: BotContext): Promise<boolean> {
  try {
    const msg = ctx.message
    if (!msg || !ctx.chat) return false

    const rawMsg = msg as unknown as Record<string, unknown>
    const replyMsg = rawMsg.reply_to_message as Record<string, unknown> | undefined

    const entry: IndexEntry = {
      messageId: msg.message_id,
      chatId: ctx.chat.id,
      type: getMessageType(rawMsg),
      timestamp: msg.date * 1000,  // Telegram uses seconds, we use ms
      fromBot: false,
      preview: getPreview(rawMsg),
      tags: [],
      voiceFileId: getVoiceFileId(rawMsg),
      fileId: getFileId(rawMsg),
      replyToId: replyMsg ? (replyMsg.message_id as number) : undefined,
    }

    addEntry(entry)
  } catch {
    // Never let indexing errors affect message flow
  }

  return false  // never consume
}

/**
 * Index a bot reply (called after bot sends a message).
 * This is optional — can be called from queue-processor if desired.
 */
export function indexBotReply(chatId: number, messageId: number, text: string): void {
  try {
    addEntry({
      messageId,
      chatId,
      type: 'text',
      timestamp: Date.now(),
      fromBot: true,
      preview: text.slice(0, 100).replace(/\n/g, ' '),
      tags: [],
    })
  } catch {
    // Silent
  }
}
