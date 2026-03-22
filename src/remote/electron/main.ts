/**
 * ClaudeBot Remote Agent — Electron main process.
 *
 * Connects to the ClaudeBot relay server and executes
 * filesystem / shell operations locally on behalf of Claude.
 * Communicates with the renderer via IPC for UI updates.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

// --- GPU workaround: remote desktop / VM environments hang on GPU init ---
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-software-rasterizer')

// --- File-based diagnostics (stderr may be swallowed by Electron/npx) ---

const LOG_PATH = resolve(process.cwd(), 'data', 'electron-debug.log')
function elog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
    appendFileSync(LOG_PATH, line, 'utf-8')
  } catch { /* best effort */ }
  console.error(msg)
}

elog(`[electron] === STARTUP === pid=${process.pid} argv=${process.argv.join(' ')}`)

process.on('uncaughtException', (err) => {
  elog(`[electron] uncaughtException: ${err.message}\n${err.stack}`)
})

process.on('unhandledRejection', (reason) => {
  elog(`[electron] unhandledRejection: ${reason}`)
})
import type { ToolDispatcher } from '../tool-handlers/index.js'
import type {
  AgentRegister,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
  ElectronChatRegister,
  LicenseRegister,
} from '../protocol.js'

// --- State ---

let mainWindow: BrowserWindow | null = null
let ws: WebSocket | null = null
let shouldReconnect = false
let toolDispatcher: ToolDispatcher | null = null

// --- Electron config (projectsBaseDir etc.) ---

const CONFIG_PATH = resolve(process.cwd(), 'data', 'electron-config.json')

interface ElectronConfig {
  readonly projectsBaseDir?: string
  readonly licenseKey?: string
  readonly relayUrl?: string
}

function loadConfig(): ElectronConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveConfig(patch: Partial<ElectronConfig>): ElectronConfig {
  const current = loadConfig()
  const updated = { ...current, ...patch }
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}

function getProjectsBaseDir(): string {
  return loadConfig().projectsBaseDir ?? process.cwd()
}

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
    const msg: AgentRegister = { type: 'agent_register', code, baseDir: process.cwd() }
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

ipcMain.handle('connect', async (_event, relayUrl: string, code: string, baseDir: string) => {
  const resolvedDir = resolve(baseDir || process.cwd())
  // Lazy-load tool-handlers only in agent mode (heavy module with child_process deps)
  const { createToolDispatcher } = await import('../tool-handlers/index.js')
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

// --- License mode ---

const DEFAULT_RELAY_URL = 'wss://relay.claudebot.app'

function connectLicense(relayUrl: string, licenseKey: string): void {
  setStatus('connecting')
  log('正在連線...')

  const clientId = getClientId()
  const socket = new WebSocket(relayUrl)

  socket.on('open', () => {
    const msg: LicenseRegister = { type: 'license_register', licenseKey, clientId }
    socket.send(JSON.stringify(msg))
  })

  socket.on('message', (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'license_registered') {
      chatWs = socket
      setStatus('connected')
      log(`已連線! (方案: ${msg.plan})`)
      sendToRenderer('license:connected', { plan: msg.plan })
      return
    }

    if (msg.type === 'license_error') {
      log(`序號錯誤: ${msg.error}`)
      sendToRenderer('license:error', { error: msg.error })
      socket.close()
      return
    }

    if (msg.type === 'error') {
      log(`連線錯誤: ${msg.error}`)
      sendToRenderer('license:error', { error: msg.error })
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
      log('連線中斷，3 秒後重新連線...')
      setTimeout(() => connectLicense(relayUrl, licenseKey), 3_000)
    } else {
      log('已斷線')
    }
  })

  socket.on('error', (err) => {
    log(`連線錯誤: ${err.message}`)
  })
}

ipcMain.handle('license-connect', async (_event, licenseKey: string) => {
  const config = loadConfig()
  const relayUrl = config.relayUrl ?? DEFAULT_RELAY_URL

  // Save license key for auto-reconnect
  saveConfig({ licenseKey, relayUrl })

  chatShouldReconnect = true
  chatClientMsgId = 1
  connectLicense(relayUrl, licenseKey)

  // Also start agent connection for remote tool execution
  const projDir = getProjectsBaseDir()
  const { createToolDispatcher } = await import('../tool-handlers/index.js')
  toolDispatcher = createToolDispatcher(projDir)
  shouldReconnect = true
  connectToRelay(relayUrl, licenseKey)
})

ipcMain.handle('get-license-key', () => {
  return loadConfig().licenseKey ?? null
})

ipcMain.handle('set-relay-url', (_event, url: string) => {
  saveConfig({ relayUrl: url })
  return url
})

// --- Window control IPC handlers ---

ipcMain.handle('window-minimize', () => mainWindow?.minimize())
ipcMain.handle('window-close', () => mainWindow?.close())

ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWindow) return false
  const next = !mainWindow.isAlwaysOnTop()
  mainWindow.setAlwaysOnTop(next)
  return next
})

ipcMain.handle('set-projects-dir', async (_event, dir: string) => {
  const resolvedDir = resolve(dir)
  saveConfig({ projectsBaseDir: resolvedDir })
  // Recreate tool dispatcher with new base dir
  const { createToolDispatcher } = await import('../tool-handlers/index.js')
  toolDispatcher = createToolDispatcher(resolvedDir)
  elog(`[electron] projectsBaseDir set to: ${resolvedDir}`)
  return resolvedDir
})

ipcMain.handle('get-projects-dir', () => {
  return getProjectsBaseDir()
})

let isCompact = false
const FULL_SIZE = { width: 420, height: 640 }
const COMPACT_SIZE = { width: 340, height: 280 }

ipcMain.handle('toggle-compact', () => {
  if (!mainWindow) return false
  isCompact = !isCompact
  const size = isCompact ? COMPACT_SIZE : FULL_SIZE
  mainWindow.setSize(size.width, size.height)
  mainWindow.setResizable(!isCompact)
  return isCompact
})

// --- Window ---

function isChatMode(): boolean {
  return process.argv.includes('--chat')
}

/** Resolve an asset file: try __dirname first (dist/), fall back to src/ (dev) */
function resolveAsset(...parts: string[]): string {
  const distPath = resolve(__dirname, ...parts)
  if (existsSync(distPath)) return distPath
  return resolve(process.cwd(), 'src', 'remote', 'electron', ...parts)
}

function createWindow(): void {
  const chatMode = isChatMode()
  const cwd = process.cwd()

  const preloadPath = resolveAsset('preload.cjs')
  const htmlFile = chatMode ? 'chat.html' : 'index.html'
  const htmlPath = resolveAsset('renderer', htmlFile)

  elog(`[electron] mode=${chatMode ? 'chat' : 'agent'} cwd=${cwd}`)
  elog(`[electron] preload=${preloadPath} exists=${existsSync(preloadPath)}`)
  elog(`[electron] html=${htmlPath} exists=${existsSync(htmlPath)}`)

  mainWindow = new BrowserWindow({
    width: chatMode ? 420 : 600,
    height: chatMode ? 640 : 500,
    title: chatMode ? 'ClaudeBot Chat' : 'ClaudeBot Remote Agent',
    resizable: true,
    ...(chatMode ? { frame: false, titleBarStyle: 'hidden' as const } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(htmlPath).catch((err) => {
    elog(`[electron] loadFile failed: ${err.message}`)
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    elog(`[electron] did-fail-load: ${code} ${desc}`)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- Connection params: env vars (preferred) or CLI args ---
// IMPORTANT: Chromium crashes when argv contains wss:// or https:// URLs,
// so we pass connection params via environment variables instead.

function getParam(name: string): string | undefined {
  // Env var takes priority (set by launch-electron.cjs / pair command)
  const envKey = `CLAUDEBOT_${name.toUpperCase()}`
  if (process.env[envKey]) return process.env[envKey]
  // Fallback: CLI arg (only safe for non-URL values)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined
  return process.argv[idx + 1]
}

// --- App lifecycle ---

elog(`[electron] starting... argv=${process.argv.join(' ')}`)

app.whenReady().then(async () => {
  elog('[electron] app ready, creating window...')
  createWindow()

  // Auto-connect if url and code provided (from /pair chat command)
  const cliUrl = getParam('url')
  const cliCode = getParam('code')
  elog(`[electron] cli: url=${cliUrl ?? 'none'} code=${cliCode ?? 'none'} chat=${isChatMode()}`)
  if (isChatMode() && cliUrl && cliCode) {
    chatRelayUrl = cliUrl
    chatCode = cliCode
    chatShouldReconnect = true
    chatClientMsgId = 1

    // Chat mode also needs agent connection for remote tool execution.
    // Without this, Claude has no remote_* tools and can't operate on this machine.
    const projDir = getProjectsBaseDir()
    const { createToolDispatcher } = await import('../tool-handlers/index.js')
    toolDispatcher = createToolDispatcher(projDir)
    shouldReconnect = true
    elog(`[electron] chat mode: agent baseDir=${projDir}`)

    // Small delay so renderer is ready to receive IPC events
    setTimeout(() => {
      connectChat(cliUrl, cliCode)
      connectToRelay(cliUrl, cliCode)
    }, 100)
  } else if (isChatMode()) {
    // Auto-reconnect with saved license key if available
    const config = loadConfig()
    if (config.licenseKey) {
      const relayUrl = config.relayUrl ?? DEFAULT_RELAY_URL
      chatShouldReconnect = true
      chatClientMsgId = 1

      const projDir = getProjectsBaseDir()
      const { createToolDispatcher } = await import('../tool-handlers/index.js')
      toolDispatcher = createToolDispatcher(projDir)
      shouldReconnect = true
      elog(`[electron] license auto-connect: key=${config.licenseKey.slice(0, 7)}... relay=${relayUrl}`)

      setTimeout(() => {
        connectLicense(relayUrl, config.licenseKey!)
        connectToRelay(relayUrl, config.licenseKey!)
      }, 100)
    }
  }
}).catch((err) => {
  elog(`[electron] app.whenReady() failed: ${err.message}`)
  process.exit(1)
})

app.on('window-all-closed', () => {
  elog('[electron] all windows closed, quitting.')
  disconnect()
  disconnectChat()
  app.quit()
})
