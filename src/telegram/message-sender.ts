import type { Telegram } from 'telegraf'
import { tailText, splitText } from '../utils/text-splitter.js'

const EDIT_DEBOUNCE_MS = 1000
const TELEGRAM_MAX_LENGTH = 4096

interface PendingEdit {
  lastText: string
  pendingText: string | null
  timer: ReturnType<typeof setTimeout> | null
}

const pending = new Map<string, PendingEdit>()

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

export function updateStreamMessage(
  chatId: number,
  messageId: number,
  accumulated: string,
  telegram: Telegram
): void {
  const k = key(chatId, messageId)
  let edit = pending.get(k)

  if (!edit) {
    edit = { lastText: '', pendingText: null, timer: null }
    pending.set(k, edit)
  }

  const displayText = tailText(accumulated, TELEGRAM_MAX_LENGTH - 50)
  edit.pendingText = displayText

  if (edit.timer) {
    clearTimeout(edit.timer)
  }

  edit.timer = setTimeout(() => {
    flushEdit(chatId, messageId, edit!, telegram)
  }, EDIT_DEBOUNCE_MS)
}

export function cancelPendingEdit(chatId: number, messageId: number): void {
  const k = key(chatId, messageId)
  const edit = pending.get(k)
  if (edit?.timer) {
    clearTimeout(edit.timer)
  }
  pending.delete(k)
}

export async function finalizeMessage(
  chatId: number,
  messageId: number,
  accumulated: string,
  footer: string,
  telegram: Telegram
): Promise<void> {
  const k = key(chatId, messageId)
  const edit = pending.get(k)

  if (edit?.timer) {
    clearTimeout(edit.timer)
  }
  pending.delete(k)

  const fullText = accumulated
    ? accumulated + '\n\n' + footer
    : footer

  if (fullText.length <= TELEGRAM_MAX_LENGTH) {
    await safeEdit(telegram, chatId, messageId, fullText)
    return
  }

  const chunks = splitText(fullText, TELEGRAM_MAX_LENGTH)
  if (chunks.length > 0) {
    await safeEdit(telegram, chatId, messageId, chunks[0])
    for (let i = 1; i < chunks.length; i++) {
      await telegram.sendMessage(chatId, chunks[i])
    }
  }
}

function flushEdit(
  chatId: number,
  messageId: number,
  edit: PendingEdit,
  telegram: Telegram
): void {
  edit.timer = null
  if (!edit.pendingText || edit.pendingText === edit.lastText) return

  const text = edit.pendingText
  edit.lastText = text
  edit.pendingText = null

  safeEdit(telegram, chatId, messageId, text).catch(() => {})
}

async function safeEdit(
  telegram: Telegram,
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  try {
    await telegram.editMessageText(chatId, messageId, undefined, text)
  } catch (error) {
    if (error instanceof Error && error.message.includes('message is not modified')) {
      return
    }
    throw error
  }
}
