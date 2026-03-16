/**
 * Electron Chat Bridge — receives chat messages from relay, injects into bot pipeline.
 *
 * Text messages → ordered-message-buffer → queue (same path as Telegram messages)
 * Commands → getCoreCommandHandler / dispatchPluginCommand via createFakeContext
 * Callbacks → callback-handler via fake callback context
 */

import type { WebSocket } from 'ws'
import type { ChatMessage, ChatCallback } from './chat-protocol.js'
import { autoAuth } from '../auth/auth-service.js'
import { getUserState } from '../bot/state.js'
import { addText } from '../bot/ordered-message-buffer.js'
import { createFakeContext } from '../utils/fake-context.js'
import { getCoreCommandHandler, getBotInstance } from '../bot/bot.js'
import { isPluginCommand, dispatchPluginCommand } from '../plugins/loader.js'
import { getPluginModule } from '../plugins/loader.js'

/**
 * Allowlist of commands Electron chat users can use.
 * Mirrors REMOTE_ALLOWED_COMMANDS from auth middleware, plus useful extras.
 */
const ALLOWED_COMMANDS = new Set([
  'start', 'login', 'help', 'status', 'cancel', 'new',
  'model', 'projects', 'select', 'chat',
  'fav', 'todo', 'todos', 'idea', 'ideas',
  'ctx', 'deep', 'last', 'last1', 'last2', 'last3', 'last4', 'last5',
  'context', 'prompt', 'store',
])

/** Incrementing message ID for bridge-originated messages. */
let bridgeMsgId = 800_000

function sendText(ws: WebSocket, text: string): void {
  if (ws.readyState !== ws.OPEN) return
  ws.send(JSON.stringify({
    type: 'chat_response',
    messageId: bridgeMsgId++,
    text,
  }))
}

/**
 * Handle a text message from an Electron chat client.
 */
export async function handleElectronChatMessage(
  ws: WebSocket,
  virtualChatId: number,
  msg: ChatMessage,
): Promise<void> {
  const text = msg.text.trim()
  if (!text) return

  // Auto-auth virtual user
  autoAuth(virtualChatId)

  const bot = getBotInstance()
  if (!bot) return

  // Check if it's a command
  if (text.startsWith('/')) {
    const cmdName = text.slice(1).split(/[@\s]/)[0].toLowerCase()

    if (!ALLOWED_COMMANDS.has(cmdName)) {
      sendText(ws, '🚫 此指令無法在桌面客戶端使用')
      return
    }

    // Try core handler
    const handler = getCoreCommandHandler(cmdName)
    if (handler) {
      const ctx = createFakeContext({
        chatId: virtualChatId,
        commandText: text,
        telegram: bot.telegram,
      })
      try {
        await handler(ctx)
      } catch (err) {
        sendText(ws, `❌ 指令執行失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // Try plugin command
    if (isPluginCommand(cmdName)) {
      const ctx = createFakeContext({
        chatId: virtualChatId,
        commandText: text,
        telegram: bot.telegram,
      })
      try {
        await dispatchPluginCommand(cmdName, ctx)
      } catch (err) {
        sendText(ws, `❌ 插件指令執行失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // Unknown command — treat as regular text (fall through)
  }

  // Regular text message — needs project selected
  const state = getUserState(virtualChatId)
  if (!state.selectedProject) {
    sendText(ws, '⚠️ 請先用 /projects 選擇專案')
    return
  }

  // Allot gate for remote projects
  if (state.selectedProject.name === 'remote') {
    const allotMod = getPluginModule('allot') as Record<string, unknown> | undefined
    if (allotMod?.tryReserve) {
      const check = (allotMod.tryReserve as (c: number, t: number | undefined) => { allowed: boolean; reason?: string })(virtualChatId, undefined)
      if (!check.allowed) {
        sendText(ws, check.reason ?? '⏳ 額度已用完')
        return
      }
    }
  }

  // Feed into ordered message buffer (same path as Telegram text messages)
  addText(virtualChatId, msg.messageId, undefined, text, '')
}

/**
 * Handle a button callback from an Electron chat client.
 */
export async function handleElectronChatCallback(
  ws: WebSocket,
  virtualChatId: number,
  msg: ChatCallback,
): Promise<void> {
  autoAuth(virtualChatId)

  const bot = getBotInstance()
  if (!bot) return

  // Build a minimal fake context with callbackQuery
  const ctx = createFakeContext({
    chatId: virtualChatId,
    commandText: '',
    telegram: bot.telegram,
  })

  // Attach callbackQuery data for the callback handler
  const fakeCallbackQuery = {
    id: String(msg.messageId),
    data: msg.data,
    message: {
      message_id: msg.messageId,
      chat: { id: virtualChatId },
      text: '',
      date: Math.floor(Date.now() / 1000),
    },
    chat_instance: String(virtualChatId),
  }

  Object.defineProperty(ctx, 'callbackQuery', { value: fakeCallbackQuery, writable: false })

  // Provide answerCbQuery as no-op (Electron doesn't need it)
  Object.defineProperty(ctx, 'answerCbQuery', {
    value: () => Promise.resolve(true),
    writable: false,
  })

  // Provide editMessageText that routes through telegram proxy
  Object.defineProperty(ctx, 'editMessageText', {
    value: (text: string, extra?: Record<string, unknown>) =>
      bot.telegram.editMessageText(virtualChatId, msg.messageId, undefined, text, extra),
    writable: false,
  })

  // Provide editMessageReplyMarkup
  Object.defineProperty(ctx, 'editMessageReplyMarkup', {
    value: (markup: unknown) =>
      bot.telegram.editMessageReplyMarkup(virtualChatId, msg.messageId, undefined, markup as Parameters<typeof bot.telegram.editMessageReplyMarkup>[3]),
    writable: false,
  })

  try {
    // First try plugin callbacks
    const { dispatchPluginCallback } = await import('../plugins/loader.js')
    const pluginHandled = await dispatchPluginCallback(ctx, msg.data)
    if (pluginHandled) return

    // Import and call the callback handler
    const { callbackHandler } = await import('../bot/handlers/callback-handler.js')
    await callbackHandler(ctx)
  } catch (err) {
    sendText(ws, `❌ 回調處理失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
}
