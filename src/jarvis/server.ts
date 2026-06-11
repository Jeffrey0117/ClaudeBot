/**
 * Jarvis voice UI server — HTTP (serves the red-dot page) + WebSocket.
 *
 * Speech text from the page is enqueued as an admin-chat message (shared
 * session with Telegram — same conversation, different face). The final
 * response is captured via the response-broker (dashboardCommandId) and
 * pushed back over the WebSocket for TTS.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { env } from '../config/env.js'
import { getUserState } from '../bot/state.js'
import { resolveBackend } from '../ai/types.js'
import { getAISessionId } from '../ai/session-store.js'
import { isChannelEnabled } from '../ai/channel/opt-in-store.js'
import { enqueue } from '../claude/queue.js'
import { onResponseEvent } from '../dashboard/response-broker.js'
import { isSherpaAvailable } from '../asr/sherpa-client.js'
import { detectRemoteIntent } from '../utils/remote-intent.js'
import { getPairing } from '../remote/pairing-store.js'
import { jarvisPage } from './page.js'
import { isValidToken, tokenFromUrl } from './auth.js'

const COMMAND_PREFIX = 'jarvis-'

const VOICE_HINT =
  '\n\n[語音模式] 這則訊息來自語音介面,使用者用說的跟你互動,' +
  '文字是語音辨識的結果,可能有錯字或被拆錯的詞(特別是英文、專有名詞、專案名),' +
  '請用上下文推斷真正的意思,不確定就反問。' +
  '要求做的動作(開網頁、跑指令、改檔案等)就真的執行,不要只口頭答應;' +
  '回答用口語化中文,1~3 句講完重點,不要列點、不要程式碼區塊。' +
  '內容很長時先一句話講結論,細節照常輸出即可(完整文字會同步到 Telegram)。'

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

/**
 * Fast path: deterministic media/app intents (「我要聽 X」「大聲一點」「暫停」…)
 * execute directly — same recipes the dashboard uses — and reply instantly,
 * never touching the AI queue. Returns true when the intent was handled
 * (successfully or with a reported error).
 */
async function tryFastIntent(ws: WebSocket, text: string): Promise<boolean> {
  const intent = detectRemoteIntent(text)
  if (!intent) return false
  const chatId = env.ADMIN_CHAT_ID
  const pairing = chatId
    ? getPairing(chatId, undefined, getUserState(chatId).activeMachine)
    : null

  try {
    if (pairing?.connected) {
      const { remoteToolCall } = await import('../remote/relay-client.js')
      if (intent.js) {
        await remoteToolCall(pairing.code, 'remote_browser_eval', { js: intent.js }, 90_000)
        if (intent.thenJs) {
          const then2 = intent.thenJs
          void (async () => {
            await new Promise((r) => setTimeout(r, 4000))
            await remoteToolCall(pairing.code, 'remote_browser_eval', { js: then2 }, 60_000).catch(() => {})
          })()
        }
      } else if (intent.spawnArgs) {
        await remoteToolCall(pairing.code, 'remote_spawn_detached', { command: 'cmd', args: JSON.stringify(intent.spawnArgs) }, 15_000)
      } else if (intent.command) {
        await remoteToolCall(pairing.code, 'remote_execute_command', { command: intent.command }, 30_000)
      }
    } else if (intent.spawnArgs) {
      // No paired machine — GUI launches still work on the bot's own machine
      spawn('cmd', [...intent.spawnArgs], { detached: true, stdio: 'ignore', shell: false }).unref()
    } else {
      return false // CDP-only intent with no pairing — let the AI handle it
    }
    send(ws, { type: 'answer', text: intent.reply })
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message.slice(0, 120) : String(error)
    send(ws, { type: 'error', text: `${intent.kind} 失敗:${msg}` })
    return true
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

const ASR_MAX_BYTES = 20 * 1024 * 1024
const ASR_TEMP_DIR = join(tmpdir(), 'claudebot-voice')

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** POST /asr — recorded audio blob in, Sherpa-transcribed text out. */
async function handleAsr(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (code: number, body: Record<string, unknown>) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (!isSherpaAvailable()) {
    json(503, { ok: false, error: 'Sherpa ASR 未啟動' })
    return
  }
  const audioPath = join(ASR_TEMP_DIR, `jarvis-${randomUUID()}.webm`)
  try {
    const body = await readBody(req, ASR_MAX_BYTES)
    if (body.length < 200) {
      json(400, { ok: false, error: '音檔太短' })
      return
    }
    await mkdir(ASR_TEMP_DIR, { recursive: true })
    await writeFile(audioPath, body)
    const { transcribeLocalAudio } = await import('../bot/handlers/voice-handler.js')
    const result = await transcribeLocalAudio(audioPath)
    if (!result.text) {
      json(422, { ok: false, error: result.error ?? '辨識失敗' })
      return
    }
    json(200, { ok: true, text: result.text })
  } catch (error) {
    console.error('[jarvis] ASR failed:', error)
    json(500, { ok: false, error: '辨識處理出錯' })
  } finally {
    await unlink(audioPath).catch(() => {})
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
    if (path === '/asr' && req.method === 'POST') {
      if (!isAuthorized(req, token)) {
        res.writeHead(401)
        res.end()
        return
      }
      handleAsr(req, res).catch((err) => {
        console.error('[jarvis] ASR handler crashed:', err)
        res.writeHead(500)
        res.end()
      })
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

    // Capability handshake — the page picks Sherpa or Web Speech based on this
    send(ws, { type: 'hello', asr: isSherpaAvailable() })

    ws.on('message', (raw) => {
      let text: string
      try {
        const parsed = askSchema.safeParse(JSON.parse(String(raw)))
        if (!parsed.success) {
          send(ws, { type: 'error', text: '訊息格式不對' })
          return
        }
        text = parsed.data.text
      } catch {
        send(ws, { type: 'error', text: '處理訊息時出錯了' })
        return
      }
      void tryFastIntent(ws, text)
        .then((handled) => { if (!handled) handleAsk(ws, text) })
        .catch((error) => {
          console.error('[jarvis] message handling failed:', error)
          send(ws, { type: 'error', text: '處理訊息時出錯了' })
        })
    })

    ws.on('close', () => dropConnection(ws))
    ws.on('error', () => dropConnection(ws))
  })

  wireResponseEvents()

  httpServer.listen(port, () => {
    console.log(`[jarvis] voice UI at http://localhost:${port}/?token=***`)
  })
}
