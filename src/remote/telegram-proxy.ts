/**
 * TelegramProxy — wraps bot.telegram with a Proxy that intercepts API calls
 * targeting virtual chatIds (negative numbers = Electron users).
 *
 * Real Telegram chatIds (positive) pass through to the original API unchanged.
 * Virtual chatIds are routed through WebSocket to the Electron chat client.
 *
 * This makes the entire bot pipeline (queue-processor, commands, plugins,
 * draft-sender) work transparently for Electron users with zero modifications.
 */

import type { WebSocket } from 'ws'
import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { isVirtualChat } from './virtual-chat-store.js'
import type { ChatResponse, ChatEdit, ChatDelete, ChatStatus } from './chat-protocol.js'

interface VirtualClient {
  readonly ws: WebSocket
  readonly code: string
  readonly nextMsgId: number
}

/** Active virtual chat connections: virtualChatId → client info */
const virtualClients = new Map<number, VirtualClient>()

/** Register an Electron chat client for a virtual chatId. */
export function registerVirtualChat(virtualChatId: number, ws: WebSocket, code: string): void {
  virtualClients.set(virtualChatId, { ws, code, nextMsgId: 1 })
}

/** Unregister an Electron chat client (on disconnect). */
export function unregisterVirtualChat(virtualChatId: number): void {
  virtualClients.delete(virtualChatId)
}

/** Allocate next message ID for a virtual client (immutable update). */
function allocateMsgId(chatId: number): number {
  const client = virtualClients.get(chatId)
  if (!client) return 0
  const id = client.nextMsgId
  virtualClients.set(chatId, { ...client, nextMsgId: id + 1 })
  return id
}

function sendToClient(chatId: number, msg: ChatResponse | ChatEdit | ChatDelete | ChatStatus): boolean {
  const client = virtualClients.get(chatId)
  if (!client || client.ws.readyState !== client.ws.OPEN) return false
  client.ws.send(JSON.stringify(msg))
  return true
}

function extractButtons(extra?: Record<string, unknown>): ChatResponse['buttons'] | undefined {
  const markup = extra?.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined
  if (!markup?.inline_keyboard) return undefined
  return markup.inline_keyboard.map((row) =>
    row
      .filter((btn) => btn.callback_data)
      .map((btn) => ({ text: btn.text, data: btn.callback_data! }))
  ).filter((row) => row.length > 0)
}

/**
 * Wrap bot.telegram with a Proxy that intercepts virtual chatId calls.
 * Must be called after bot creation, before any handlers run.
 */
export function createTelegramProxy(
  telegram: Telegraf<BotContext>['telegram'],
): Telegraf<BotContext>['telegram'] {
  return new Proxy(telegram, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)
      if (typeof original !== 'function') return original

      // Only intercept specific methods that take chatId as first arg
      if (prop === 'sendMessage') {
        return (chatId: number, text: string, extra?: Record<string, unknown>) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, text, extra)

          const messageId = allocateMsgId(chatId)
          if (messageId === 0) return Promise.resolve({ message_id: 0 })

          const buttons = extractButtons(extra)
          const parseMode = (extra?.parse_mode as ChatResponse['parseMode']) ?? undefined

          const msg: ChatResponse = {
            type: 'chat_response',
            messageId,
            text,
            ...(parseMode ? { parseMode } : {}),
            ...(buttons && buttons.length > 0 ? { buttons } : {}),
          }
          sendToClient(chatId, msg)

          // Return a fake Message object so draft-sender can track message_id
          return Promise.resolve({ message_id: messageId })
        }
      }

      if (prop === 'editMessageText') {
        return (chatId: number, messageId: number, _inlineMessageId: string | undefined, text: string, extra?: Record<string, unknown>) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, messageId, _inlineMessageId, text, extra)

          const buttons = extractButtons(extra)
          if (buttons && buttons.length > 0) {
            // Edit with new buttons → send as chat_response (replaces)
            const msg: ChatResponse = {
              type: 'chat_response',
              messageId,
              text,
              ...(buttons.length > 0 ? { buttons } : {}),
            }
            sendToClient(chatId, msg)
          } else {
            const msg: ChatEdit = { type: 'chat_edit', messageId, text }
            sendToClient(chatId, msg)
          }

          return Promise.resolve(true)
        }
      }

      if (prop === 'deleteMessage') {
        return (chatId: number, messageId: number) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, messageId)
          const msg: ChatDelete = { type: 'chat_delete', messageId }
          sendToClient(chatId, msg)
          return Promise.resolve(true)
        }
      }

      if (prop === 'sendChatAction') {
        return (chatId: number, action: string) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, action)
          const msg: ChatStatus = { type: 'chat_status', status: 'typing' }
          sendToClient(chatId, msg)
          return Promise.resolve(true)
        }
      }

      if (prop === 'getChat') {
        return (chatId: number) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId)
          // Return minimal chat object for draft-sender compatibility
          return Promise.resolve({ id: chatId, type: 'private' })
        }
      }

      // editMessageReplyMarkup — used by callback-handler to clear buttons
      if (prop === 'editMessageReplyMarkup') {
        return (chatId: number, messageId: number, _inlineMessageId: string | undefined, markup: unknown) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, messageId, _inlineMessageId, markup)
          // For virtual chats, clearing buttons is a no-op (buttons already handled in client)
          return Promise.resolve(true)
        }
      }

      // sendPhoto — extract image URL or base64 for Electron rendering
      if (prop === 'sendPhoto') {
        return (chatId: number, photo: unknown, extra?: Record<string, unknown>) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, photo, extra)

          const messageId = allocateMsgId(chatId)
          if (messageId === 0) return Promise.resolve({ message_id: 0 })

          let mediaUrl: string | undefined
          if (typeof photo === 'string') {
            // URL string
            mediaUrl = photo
          } else if (Buffer.isBuffer(photo)) {
            mediaUrl = `data:image/png;base64,${photo.toString('base64')}`
          } else if (photo && typeof photo === 'object' && 'source' in photo) {
            const src = (photo as { source: unknown }).source
            if (Buffer.isBuffer(src)) {
              mediaUrl = `data:image/png;base64,${src.toString('base64')}`
            }
          }

          const caption = typeof extra?.caption === 'string' ? extra.caption : ''
          const msg: ChatResponse = {
            type: 'chat_response',
            messageId,
            text: caption || '',
            ...(mediaUrl ? { mediaUrl, mediaType: 'image' as const } : {}),
          }
          sendToClient(chatId, msg)
          return Promise.resolve({ message_id: messageId })
        }
      }

      // sendDocument, sendVideo, sendAudio — text placeholder (files may be too large)
      if (prop === 'sendDocument' || prop === 'sendVideo' || prop === 'sendAudio') {
        return (chatId: number, ...args: unknown[]) => {
          if (!isVirtualChat(chatId)) return original.call(target, chatId, ...args)
          const messageId = allocateMsgId(chatId)
          if (messageId === 0) return Promise.resolve({ message_id: 0 })
          const mediaName = prop === 'sendDocument' ? '文件' : prop === 'sendVideo' ? '影片' : '音訊'
          const msg: ChatResponse = {
            type: 'chat_response',
            messageId,
            text: `[${mediaName}檔案暫不支援在桌面客戶端顯示]`,
          }
          sendToClient(chatId, msg)
          return Promise.resolve({ message_id: messageId })
        }
      }

      return original.bind(target)
    },
  })
}
