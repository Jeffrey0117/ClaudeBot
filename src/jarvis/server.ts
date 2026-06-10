/**
 * Jarvis voice UI server — HTTP (serves the red-dot page) + WebSocket.
 *
 * Speech text from the page is enqueued as an admin-chat message (shared
 * session with Telegram — same conversation, different face). The final
 * response is captured via the response-broker (dashboardCommandId) and
 * pushed back over the WebSocket for TTS.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { env } from '../config/env.js'
import { getUserState } from '../bot/state.js'
import { resolveBackend } from '../ai/types.js'
import { getAISessionId } from '../ai/session-store.js'
import { isChannelEnabled } from '../ai/channel/opt-in-store.js'
import { enqueue } from '../claude/queue.js'
import { onResponseEvent } from '../dashboard/response-broker.js'
import { jarvisPage } from './page.js'
import { isValidToken, tokenFromUrl } from './auth.js'

const COMMAND_PREFIX = 'jarvis-'

const VOICE_HINT =
  '\n\n[語音模式] 這則訊息來自語音介面:請用口語化中文回答,1~3 句講完重點,' +
  '不要列點、不要程式碼區塊。內容很長時先一句話講結論,細節照常輸出即可' +
  '(完整文字會同步到 Telegram)。'

const askSchema = z.object({
  type: z.literal('ask'),
  text: z.string().min(1).max(4000),
})

/** commandId → the WebSocket waiting for that answer. */
const pending = new Map<string, WebSocket>()

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return isValidToken(tokenFromUrl(req.url), token)
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function handleAsk(ws: WebSocket, text: string): void {
  const chatId = env.ADMIN_CHAT_ID
  if (!chatId) {
    send(ws, { type: 'error', text: 'ADMIN_CHAT_ID 未設定,Jarvis 無法運作' })
    return
  }

  const state = getUserState(chatId)
  const project = state.selectedProject
  if (!project) {
    send(ws, { type: 'error', text: '還沒選專案,先在 Telegram 用 /project 選一個' })
    return
  }

  // Same backend resolution as ordered-message-buffer's flush
  const aiSel = isChannelEnabled(project.path)
    ? { backend: 'channel' as const, model: state.ai.model }
    : state.ai
  const sessionId = getAISessionId(resolveBackend(aiSel.backend), project.path)

  const commandId = `${COMMAND_PREFIX}${randomUUID()}`
  pending.set(commandId, ws)

  enqueue({
    chatId,
    prompt: `[語音輸入] ${text}${VOICE_HINT}`,
    project,
    ai: aiSel,
    sessionId,
    imagePaths: [],
    dashboardCommandId: commandId,
  })
}

function wireResponseEvents(): void {
  onResponseEvent((event) => {
    if (!event.commandId.startsWith(COMMAND_PREFIX)) return
    const ws = pending.get(event.commandId)
    if (!ws) return

    if (event.type === 'response_chunk') {
      send(ws, { type: 'chunk', text: event.accumulated })
    } else if (event.type === 'response_complete') {
      send(ws, { type: 'answer', text: event.text })
      pending.delete(event.commandId)
    } else {
      send(ws, { type: 'error', text: event.error })
      pending.delete(event.commandId)
    }
  })
}

function dropConnection(ws: WebSocket): void {
  for (const [id, socket] of pending) {
    if (socket === ws) pending.delete(id)
  }
}

export function startJarvisServer(port: number, token: string): void {
  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/' && req.method === 'GET') {
      if (!isAuthorized(req, token)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Unauthorized')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(jarvisPage())
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    if (!isAuthorized(req, token)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    ws.on('message', (raw) => {
      try {
        const parsed = askSchema.safeParse(JSON.parse(String(raw)))
        if (!parsed.success) {
          send(ws, { type: 'error', text: '訊息格式不對' })
          return
        }
        handleAsk(ws, parsed.data.text)
      } catch (error) {
        console.error('[jarvis] message handling failed:', error)
        send(ws, { type: 'error', text: '處理訊息時出錯了' })
      }
    })

    ws.on('close', () => dropConnection(ws))
    ws.on('error', () => dropConnection(ws))
  })

  wireResponseEvents()

  httpServer.listen(port, () => {
    console.log(`[jarvis] voice UI at http://localhost:${port}/?token=***`)
  })
}
