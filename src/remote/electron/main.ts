/**
 * ClaudeBot Remote Agent — Electron main process.
 *
 * Connects to the ClaudeBot relay server and executes
 * filesystem / shell operations locally on behalf of Claude.
 * Communicates with the renderer via IPC for UI updates.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { createToolDispatcher, type ToolDispatcher } from '../tool-handlers.js'
import type {
  AgentRegister,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
  ElectronChatRegister,
} from '../protocol.js'

// --- State ---

let mainWindow: BrowserWindow | null = null
let ws: WebSocket | null = null
let shouldReconnect = false
let toolDispatcher: ToolDispatcher | null = null

// Chat mode state
let chatWs: WebSocket | null = null
let chatShouldReconnect = false
let chatRelayUrl = ''
let chatCode = ''
let chatClientMsgId = 1

// --- Logging to renderer ---

function sendToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function log(message: string): void {
  sendToRenderer('log', message)
}

function setStatus(status: 'disconnected' | 'connecting' | 'connected'): void {
  sendToRenderer('status', status)
}

// --- WebSocket connection ---

function connectToRelay(relayUrl: string, code: string): void {
  setStatus('connecting')
  log(`Connecting to ${relayUrl}...`)

  const socket = new WebSocket(relayUrl)

  socket.on('open', () => {
    const msg: AgentRegister = { type: 'agent_register', code }
    socket.send(JSON.stringify(msg))
  })

  socket.on('message', async (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'agent_registered') {
      ws = socket
      setStatus('connected')
      log('Connected and paired!')
      return
    }

    if (msg.type === 'error') {
      log(`Relay error: ${msg.error}`)
      socket.close()
      return
    }

    if (msg.type === 'tool_call' && toolDispatcher) {
      const req = msg as unknown as ToolCallRequest
      const toolShort = req.tool.replace('remote_', '')
      const argsPreview = Object.values(req.args).map(String).join(', ').slice(0, 80)
      log(`[tool] ${toolShort}(${argsPreview})`)

      try {
        const result = await toolDispatcher.dispatch(req.tool, req.args)
        const resp: ToolCallResult = { id: req.id, type: 'tool_result', result }
        socket.send(JSON.stringify(resp))
        log(`  done (${result.length} chars)`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const resp: ToolCallError = { id: req.id, type: 'tool_error', error }
        socket.send(JSON.stringify(resp))
        log(`  error: ${error}`)
      }
    }
  })

  socket.on('close', () => {
    ws = null
    setStatus('disconnected')
    if (shouldReconnect) {
      log('Disconnected. Reconnecting in 3s...')
      setTimeout(() => connectToRelay(relayUrl, code), 3_000)
    } else {
      log('Disconnected.')
    }
  })

  socket.on('error', (err) => {
    log(`Connection error: ${err.message}`)
  })
}

function disconnect(): void {
  shouldReconnect = false
  if (ws) {
    ws.close()
    ws = null
  }
  setStatus('disconnected')
  log('Disconnected by user.')
}

// --- IPC handlers ---

ipcMain.handle('connect', (_event, relayUrl: string, code: string, baseDir: string) => {
  const resolvedDir = resolve(baseDir || process.cwd())
  toolDispatcher = createToolDispatcher(resolvedDir)
  shouldReconnect = true
  log(`Working directory: ${resolvedDir}`)
  connectToRelay(relayUrl, code)
})

ipcMain.handle('disconnect', () => {
  disconnect()
})

// --- Chat mode: persistent client ID ---

function getClientId(): string {
  const idPath = resolve('data', 'electron-client-id')
  try {
    const existing = readFileSync(idPath, 'utf-8').trim()
    if (existing) return existing
  } catch { /* not yet created */ }

  const newId = randomUUID()
  mkdirSync(resolve('data'), { recursive: true })
  writeFileSync(idPath, newId, 'utf-8')
  return newId
}

// --- Chat mode: WebSocket connection ---

function connectChat(relayUrl: string, code: string): void {
  setStatus('connecting')
  log('Connecting to chat...')

  const clientId = getClientId()
  const socket = new WebSocket(relayUrl)

  socket.on('open', () => {
    const msg: ElectronChatRegister = { type: 'electron_chat_register', code, clientId }
    socket.send(JSON.stringify(msg))
  })

  socket.on('message', (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'electron_chat_registered') {
      chatWs = socket
      setStatus('connected')
      log(`Chat connected! (virtual ID: ${msg.virtualChatId})`)
      return
    }

    if (msg.type === 'error') {
      log(`Relay error: ${msg.error}`)
      socket.close()
      return
    }

    // Route chat messages to renderer
    if (msg.type === 'chat_response') {
      sendToRenderer('chat:message', msg)
    } else if (msg.type === 'chat_edit') {
      sendToRenderer('chat:edit', msg)
    } else if (msg.type === 'chat_delete') {
      sendToRenderer('chat:delete', msg)
    } else if (msg.type === 'chat_status') {
      sendToRenderer('chat:status', msg)
    }
  })

  socket.on('close', () => {
    chatWs = null
    setStatus('disconnected')
    if (chatShouldReconnect) {
      log('Chat disconnected. Reconnecting in 3s...')
      setTimeout(() => connectChat(relayUrl, code), 3_000)
    } else {
      log('Chat disconnected.')
    }
  })

  socket.on('error', (err) => {
    log(`Chat connection error: ${err.message}`)
  })
}

function disconnectChat(): void {
  chatShouldReconnect = false
  if (chatWs) {
    chatWs.close()
    chatWs = null
  }
  setStatus('disconnected')
}

// --- Chat mode IPC handlers ---

ipcMain.handle('chat-connect', (_event, relayUrl: string, code: string) => {
  chatRelayUrl = relayUrl
  chatCode = code
  chatShouldReconnect = true
  chatClientMsgId = 1
  connectChat(relayUrl, code)
})

ipcMain.handle('send-message', (_event, text: string) => {
  if (!chatWs || chatWs.readyState !== chatWs.OPEN) return
  chatWs.send(JSON.stringify({
    type: 'chat_message',
    text,
    messageId: chatClientMsgId++,
  }))
})

ipcMain.handle('send-callback', (_event, data: string, msgId: number) => {
  if (!chatWs || chatWs.readyState !== chatWs.OPEN) return
  chatWs.send(JSON.stringify({
    type: 'chat_callback',
    data,
    messageId: msgId,
  }))
})

// --- Window ---

function isChatMode(): boolean {
  return process.argv.includes('--chat')
}

function createWindow(): void {
  const chatMode = isChatMode()

  mainWindow = new BrowserWindow({
    width: chatMode ? 420 : 600,
    height: chatMode ? 640 : 500,
    title: chatMode ? 'ClaudeBot Chat' : 'ClaudeBot Remote Agent',
    resizable: true,
    webPreferences: {
      preload: resolve(process.cwd(), 'src', 'remote', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const htmlFile = chatMode ? 'chat.html' : 'index.html'
  const htmlPath = resolve(process.cwd(), 'src', 'remote', 'electron', 'renderer', htmlFile)
  mainWindow.loadFile(htmlPath)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- CLI args: --url <relay> --code <pairing> → auto-connect ---

function getCliArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined
  return process.argv[idx + 1]
}

// --- App lifecycle ---

app.whenReady().then(() => {
  createWindow()

  // Auto-connect if --url and --code provided (from /pair chat command)
  const cliUrl = getCliArg('url')
  const cliCode = getCliArg('code')
  if (isChatMode() && cliUrl && cliCode) {
    chatRelayUrl = cliUrl
    chatCode = cliCode
    chatShouldReconnect = true
    chatClientMsgId = 1
    // Small delay so renderer is ready to receive IPC events
    setTimeout(() => connectChat(cliUrl, cliCode), 100)
  }
})

app.on('window-all-closed', () => {
  disconnect()
  disconnectChat()
  app.quit()
})
