import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { scanProjects } from '../config/projects.js'
import { getLockHolder } from '../claude/file-lock.js'
import { acquireCommandLock, releaseCommandLock } from './command-lock.js'
import type { BotHeartbeat, DashboardCommand } from './types.js'
import { onResponseEvent, type ResponseEvent } from './response-broker.js'
import { readChatHistory, appendChatMessage, type ChatMessage } from './chat-store.js'
import { readActivities, daysAgo, todayStart } from '../plugins/stats/activity-logger.js'
import { scanGitActivity } from '../plugins/stats/git-scanner.js'
import { handlePluginRoute } from './plugin-routes.js'
import { handleCloudPipeEvent, type PushToChat } from './cloudpipe-webhook.js'

const HEARTBEAT_DIR = join(process.cwd(), 'data', 'heartbeat')
const COMMANDS_FILE = join(process.cwd(), 'data', 'commands.json')
const WEB_DIST = join(process.cwd(), 'src', 'dashboard', 'web', 'dist')
// 30s (was 10s): tolerate brief heartbeat gaps (bot restart, busy turn, GC) so
// the dashboard doesn't flap a machine to "offline" when its agent/relay link
// is actually still up. Genuine offline still surfaces within 30s.
const HEARTBEAT_STALE_MS = 30_000
const MAX_COMMANDS_KEPT = 200

// Optional hard lock: if set, every /api/ request must present this token
// (Authorization: Bearer <t> or ?token=<t>). Even without it, the server binds
// to 127.0.0.1 and rejects cross-origin POSTs, so a remote host or a malicious
// website cannot drive the bot (POST /api/commands is effectively RCE).
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || ''

/** True if a request's Origin (if any) is a loopback origin. */
function isLocalOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // non-browser / same-origin requests omit Origin
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Returns the token presented by the request (header or query), if any. */
function presentedToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return url.searchParams.get('token') ?? ''
}

// Read live media state from a machine's CDP Chrome. Returns an OBJECT (not a
// string) so handleBrowserEval serialises it cleanly → one JSON.parse server
// side. Pure read — never launches anything. Only the dashboard polls this, and
// only for machines it knows are playing (so it never spins up Chrome on idle).
const NOWPLAYING_JS =
  "(function(){var v=document.querySelector('video');" +
  "if(!v||!isFinite(v.duration)||v.duration<=0){return {active:false};}" +
  "var pick=function(s){var e=document.querySelector(s);return e&&e.textContent?e.textContent.trim():'';};" +
  "var t=pick('.ytp-title-link')||pick('ytd-watch-metadata h1')||pick('h1.ytd-watch-metadata')||(document.title||'').replace(/ - YouTube$/,'').trim();" +
  "var ch=pick('ytd-channel-name#channel-name a')||pick('#owner #channel-name a')||pick('ytd-video-owner-renderer a');" +
  "return {active:true,playing:!v.paused,title:(t||'').slice(0,140),channel:(ch||'').slice(0,80),current:Math.floor(v.currentTime||0),duration:Math.floor(v.duration||0),volume:Math.round((v.muted?0:(v.volume||0))*100)};})()"

/** Build the CDP JS for a now-playing control action. Numeric values are
 *  clamped + coerced (never string-interpolated unsanitised) so a bad value
 *  can't inject. Returns null for an unknown action. */
function buildControlJs(action: string, value: number): string | null {
  const v = "var v=document.querySelector('video');if(!v)return false;"
  switch (action) {
    case 'toggle': return `(function(){${v}if(v.paused)v.play();else v.pause();return !v.paused;})()`
    case 'play': return `(function(){${v}v.play();return true;})()`
    case 'pause': return `(function(){${v}v.pause();return false;})()`
    case 'seek': {
      const sec = Math.max(0, Math.floor(isFinite(value) ? value : 0))
      return `(function(){${v}v.currentTime=${sec};v.play();return true;})()`
    }
    case 'volume': {
      const vol = Math.min(1, Math.max(0, isFinite(value) ? value : 0))
      return `(function(){${v}v.muted=false;v.volume=${vol};return v.volume;})()`
    }
    default: return null
  }
}

// Injected by startDashboardServer so the CloudPipe webhook can reach Telegram
// without this module importing the bot instance.
let pushToChat: PushToChat | null = null

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

// --- Validation schemas ---

const CreateCommandSchema = z.object({
  targetBot: z.string().nullable().optional().default(null),
  type: z.enum(['prompt', 'cancel', 'select_project', 'switch_model', 'new_session', 'dispatch_remote']),
  payload: z.record(z.unknown()).default({}),
})

// --- Heartbeat aggregation ---

async function readAllHeartbeats(): Promise<readonly BotHeartbeat[]> {
  try {
    const files = await readdir(HEARTBEAT_DIR)
    const jsons = files.filter((f) => f.endsWith('.json'))
    const results: BotHeartbeat[] = []

    for (const file of jsons) {
      try {
        const raw = await readFile(join(HEARTBEAT_DIR, file), 'utf-8')
        const hb = JSON.parse(raw) as BotHeartbeat
        results.push(hb)
      } catch {
        // skip malformed files
      }
    }

    return results
  } catch {
    return []
  }
}

function isStaleHeartbeat(hb: BotHeartbeat): boolean {
  return Date.now() - hb.updatedAt > HEARTBEAT_STALE_MS
}

// --- Command store (file-based with locking) ---

async function readCommands(): Promise<DashboardCommand[]> {
  try {
    const raw = await readFile(COMMANDS_FILE, 'utf-8')
    return JSON.parse(raw) as DashboardCommand[]
  } catch {
    return []
  }
}

async function writeCommands(commands: readonly DashboardCommand[]): Promise<void> {
  await mkdir(join(process.cwd(), 'data'), { recursive: true })
  const pruned = commands.length > MAX_COMMANDS_KEPT
    ? commands.slice(-MAX_COMMANDS_KEPT)
    : commands
  await writeFile(COMMANDS_FILE, JSON.stringify(pruned, null, 2), 'utf-8')
}

async function addCommand(cmd: DashboardCommand): Promise<void> {
  const locked = await acquireCommandLock('dashboard-server')
  if (!locked) {
    throw new Error('Could not acquire command lock')
  }
  try {
    const commands = await readCommands()
    await writeCommands([...commands, cmd])
  } finally {
    await releaseCommandLock()
  }
}

// --- HTTP routing ---

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  // No wildcard CORS: same-origin dashboard requests don't need it, and we must
  // not let arbitrary websites read API responses cross-origin.
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function send404(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const MAX_BODY = 64 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('Body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`)
  const path = url.pathname

  // CORS preflight — only acknowledge loopback origins.
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
    if (origin && isLocalOrigin(req)) headers['Access-Control-Allow-Origin'] = origin
    res.writeHead(204, headers)
    res.end()
    return
  }

  // --- Access control (defense-in-depth on top of the 127.0.0.1 bind) ---
  // 1. Optional token gate: if DASHBOARD_TOKEN is configured, demand it.
  if (DASHBOARD_TOKEN && presentedToken(req, url) !== DASHBOARD_TOKEN) {
    sendJson(res, { error: 'Unauthorized' }, 401)
    return
  }
  // 2. CSRF guard: a malicious website could fire a simple cross-origin POST
  //    (text/plain) at localhost to drive the bot. Reject state-changing
  //    methods whose Origin is present and non-loopback. Same-origin dashboard
  //    POSTs carry a localhost Origin and pass; non-browser callers omit Origin.
  if (req.method !== 'GET' && !isLocalOrigin(req)) {
    sendJson(res, { error: 'Forbidden: cross-origin request rejected' }, 403)
    return
  }

  // Plugin routes (before core API routes)
  if (path.startsWith('/api/plugins/')) {
    const handled = await handlePluginRoute(req, res)
    if (handled) return
  }

  // POST /api/cloudpipe/event — inbound CloudPipe webhook → Telegram push
  if (path === '/api/cloudpipe/event' && req.method === 'POST') {
    await handleCloudPipeEvent(req, res, { pushToChat, readBody, sendJson })
    return
  }

  // GET /api/status — aggregate all bot heartbeats
  if (path === '/api/status' && req.method === 'GET') {
    const heartbeats = await readAllHeartbeats()
    const bots = heartbeats.map((hb) => ({
      ...hb,
      online: !isStaleHeartbeat(hb),
    }))
    sendJson(res, { bots, timestamp: Date.now() })
    return
  }

  // GET /api/projects — scan projects + lock status
  if (path === '/api/projects' && req.method === 'GET') {
    const projects = scanProjects()
    const projectsWithLock = await Promise.all(
      projects.map(async (p) => {
        const lockHolder = await getLockHolder(p.path)
        return { ...p, lockHolder }
      })
    )
    sendJson(res, { projects: projectsWithLock })
    return
  }

  // GET /api/nowplaying?code=XXX — live media state from a machine's CDP Chrome
  if (path === '/api/nowplaying' && req.method === 'GET') {
    const code = url.searchParams.get('code') ?? ''
    if (!code) { sendJson(res, { active: false }); return }
    try {
      const { callAgentTool } = await import('../remote/relay-server.js')
      const raw = await callAgentTool(code, 'remote_browser_eval', { js: NOWPLAYING_JS }, 8_000)
      const data = JSON.parse(raw) as { active?: boolean }
      if (data && data.active) { sendJson(res, data); return }
    } catch { /* not connected / no CDP / non-JSON error → inactive */ }
    sendJson(res, { active: false })
    return
  }

  // POST /api/nowplaying/control — seek / play / pause / volume on a machine's Chrome
  if (path === '/api/nowplaying/control' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as { code?: string; action?: string; value?: number }
      const code = String(body.code ?? '')
      const js = buildControlJs(String(body.action ?? ''), Number(body.value))
      if (!code || !js) { sendJson(res, { ok: false }, 400); return }
      const { callAgentTool } = await import('../remote/relay-server.js')
      await callAgentTool(code, 'remote_browser_eval', { js }, 8_000)
      sendJson(res, { ok: true })
    } catch {
      sendJson(res, { ok: false })
    }
    return
  }

  // POST /api/commands — create a new command
  if (path === '/api/commands' && req.method === 'POST') {
    try {
      const raw = JSON.parse(await readBody(req))
      const validated = CreateCommandSchema.parse(raw)
      // Use targetBot from request if specified, otherwise null (any bot can claim)
      const effectiveTarget = validated.targetBot ?? null
      const cmd: DashboardCommand = {
        id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        targetBot: effectiveTarget,
        type: validated.type,
        payload: validated.payload,
        createdAt: Date.now(),
        status: 'pending',
        claimedBy: null,
      }
      await addCommand(cmd)

      // Track project for response persistence + persist user message
      if (cmd.type === 'prompt') {
        const project = typeof cmd.payload.project === 'string'
          ? cmd.payload.project
          : null
        if (project) {
          trackCommand(cmd.id, project)
          const userMsg: ChatMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'user',
            content: String(cmd.payload.prompt ?? ''),
            botId: null,
            projectName: project,
            timestamp: Date.now(),
            commandId: cmd.id,
          }
          appendChatMessage(project, userMsg).catch(() => {})
        }
      }

      sendJson(res, { command: cmd }, 201)
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
        : 'Invalid request body'
      sendJson(res, { error: message }, 400)
    }
    return
  }

  // GET /api/commands/:id — query command status
  const cmdMatch = path.match(/^\/api\/commands\/(.+)$/)
  if (cmdMatch && req.method === 'GET') {
    const commands = await readCommands()
    const cmd = commands.find((c) => c.id === cmdMatch[1])
    if (cmd) {
      sendJson(res, { command: cmd })
    } else {
      sendJson(res, { error: 'Command not found' }, 404)
    }
    return
  }

  // GET /api/commands — list recent commands
  if (path === '/api/commands' && req.method === 'GET') {
    const commands = await readCommands()
    const recent = commands.slice(-50)
    sendJson(res, { commands: recent })
    return
  }

  // GET /api/chat/:project — get chat history for a project
  const chatMatch = path.match(/^\/api\/chat\/(.+)$/)
  if (chatMatch && req.method === 'GET') {
    try {
      const project = decodeURIComponent(chatMatch[1])
      const messages = await readChatHistory(project)
      const recent = messages.slice(-50)
      sendJson(res, { messages: recent })
    } catch {
      sendJson(res, { error: 'Invalid project name' }, 400)
    }
    return
  }

  // GET /api/stats?range=today|week|month
  if (path === '/api/stats' && req.method === 'GET') {
    const range = url.searchParams.get('range') ?? 'today'
    let since: number
    let sinceISO: string

    if (range === 'week') {
      since = daysAgo(7)
      sinceISO = new Date(since).toISOString().slice(0, 10)
    } else if (range === 'month') {
      const now = new Date()
      since = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      sinceISO = new Date(since).toISOString().slice(0, 10)
    } else {
      since = todayStart()
      sinceISO = new Date(since).toISOString().slice(0, 10)
    }

    const activities = readActivities(since, Date.now())
    const git = scanGitActivity(sinceISO)

    const promptEvents = activities.filter((a) => a.type === 'prompt_complete')
    sendJson(res, {
      range,
      activities: {
        prompts: promptEvents.length,
        messages: activities.filter((a) => a.type === 'message_sent').length,
        voices: activities.filter((a) => a.type === 'voice_sent').length,
        totalCost: promptEvents.reduce((s, a) => s + (a.costUsd ?? 0), 0),
        totalDuration: promptEvents.reduce((s, a) => s + (a.durationMs ?? 0), 0),
        totalTools: promptEvents.reduce((s, a) => s + (a.toolCount ?? 0), 0),
      },
      git: {
        totalCommits: git.totalCommits,
        totalInsertions: git.totalInsertions,
        totalDeletions: git.totalDeletions,
        projects: git.projects.slice(0, 20),
        hourDistribution: git.hourDistribution,
        dailyCommits: git.dailyCommits,
      },
    })
    return
  }

  send404(res)
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let filePath = join(WEB_DIST, req.url === '/' ? 'index.html' : req.url ?? '')

  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
  } catch {
    // SPA fallback: serve index.html for non-file paths
    filePath = join(WEB_DIST, 'index.html')
  }

  try {
    const content = await readFile(filePath)
    const ext = extname(filePath)
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(content)
    return true
  } catch {
    return false
  }
}

// --- WebSocket relay ---

function startWsRelay(wss: WebSocketServer): void {
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', (err) => {
      console.error('[dashboard] WebSocket error:', err)
      clients.delete(ws)
    })
  })

  function broadcast(data: unknown): void {
    const payload = JSON.stringify(data)
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(payload)
      }
    }
  }

  // Broadcast heartbeats every 2s
  setInterval(async () => {
    if (clients.size === 0) return
    try {
      const heartbeats = await readAllHeartbeats()
      broadcast({
        type: 'heartbeat',
        bots: heartbeats.map((hb) => ({
          ...hb,
          online: !isStaleHeartbeat(hb),
        })),
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('[dashboard] Heartbeat broadcast error:', err)
    }
  }, 2_000)

  // Subscribe to response broker events → broadcast + persist
  onResponseEvent((event: ResponseEvent) => {
    // Enrich events with projectName for frontend routing
    const projectName = commandProjectMap.get(event.commandId) ?? null
    broadcast({ ...event, projectName })

    if (event.type === 'response_complete') {
      const msg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: event.text,
        botId: event.botId,
        projectName: commandProjectMap.get(event.commandId) ?? 'unknown',
        timestamp: Date.now(),
        commandId: event.commandId,
      }
      const project = commandProjectMap.get(event.commandId)
      if (project) {
        appendChatMessage(project, msg).catch(() => {})
        commandProjectMap.delete(event.commandId)
      }
    }

    if (event.type === 'response_error') {
      const project = commandProjectMap.get(event.commandId)
      if (project) {
        const msg: ChatMessage = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: 'system',
          content: `Error: ${event.error}`,
          botId: null,
          projectName: project,
          timestamp: Date.now(),
          commandId: event.commandId,
        }
        appendChatMessage(project, msg).catch(() => {})
        commandProjectMap.delete(event.commandId)
      }
    }
  })
}

// Track which commandId belongs to which project for chat persistence
// Entries auto-expire after 35 minutes to prevent unbounded growth
const commandProjectMap = new Map<string, string>()
const COMMAND_MAP_TTL_MS = 35 * 60 * 1000

function trackCommand(commandId: string, project: string): void {
  commandProjectMap.set(commandId, project)
  setTimeout(() => commandProjectMap.delete(commandId), COMMAND_MAP_TTL_MS)
}

// --- Main entry ---

export function startDashboardServer(port: number, push?: PushToChat): void {
  pushToChat = push ?? null

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'

    // API routes
    if (url.startsWith('/api/')) {
      await handleApi(req, res)
      return
    }

    // Static files
    const served = await serveStatic(req, res)
    if (!served) {
      send404(res)
    }
  })

  const wss = new WebSocketServer({ server })
  startWsRelay(wss)

  // Bind loopback by default — the API can drive the bot (POST /api/commands),
  // so it must NOT be exposed on the network. Override with DASHBOARD_HOST
  // (e.g. 0.0.0.0 for LAN access) only together with DASHBOARD_TOKEN.
  const host = process.env.DASHBOARD_HOST || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && !DASHBOARD_TOKEN) {
    console.error(`[dashboard] WARNING: bound to ${host} without DASHBOARD_TOKEN — API is exposed unauthenticated.`)
  }
  server.listen(port, host, () => {
    console.log(`[dashboard] Server running at http://${host}:${port}`)
  })
}

