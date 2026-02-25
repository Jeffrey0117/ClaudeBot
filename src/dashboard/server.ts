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

const HEARTBEAT_DIR = join(process.cwd(), 'data', 'heartbeat')
const COMMANDS_FILE = join(process.cwd(), 'data', 'commands.json')
const WEB_DIST = join(process.cwd(), 'src', 'dashboard', 'web', 'dist')
const HEARTBEAT_STALE_MS = 10_000
const MAX_COMMANDS_KEPT = 200

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
  type: z.enum(['prompt', 'cancel', 'select_project', 'switch_model', 'new_session']),
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
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

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
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

  // POST /api/commands — create a new command
  if (path === '/api/commands' && req.method === 'POST') {
    try {
      const raw = JSON.parse(await readBody(req))
      const validated = CreateCommandSchema.parse(raw)
      // Dashboard prompt commands always route through main bot
      // to keep response-broker events in the same process
      const effectiveTarget = validated.type === 'prompt'
        ? 'main'
        : (validated.targetBot ?? null)
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

export function startDashboardServer(port: number): void {
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

  server.listen(port, () => {
    console.log(`[dashboard] Server running at http://localhost:${port}`)
  })
}

