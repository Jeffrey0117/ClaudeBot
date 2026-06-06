/**
 * IG quick-post web server — mobile page for picking/uploading a video,
 * writing a caption (with saved templates), and posting/scheduling to IG.
 *
 * Deliberately a SEPARATE server from the dashboard (which has unauthenticated
 * command endpoints and must stay localhost-only). This one is exposed through
 * the cloudflared tunnel, so EVERY api route requires IG_WEB_TOKEN.
 *
 * Routes:
 *   GET  /                 — the quick-post page (token gate handled client-side)
 *   GET  /api/videos?dir=  — list folders + media in IG_VIDEOS_DIR
 *   PUT  /api/upload?name= — raw-body upload into IG_VIDEOS_DIR/上傳/
 *   GET  /api/templates    — caption templates
 *   POST /api/templates    — upsert { name, content }
 *   DELETE /api/templates?name=
 *   POST /api/post         — { filename, caption } → { jobId } (async)
 *   GET  /api/job?id=      — job status/result
 *   POST /api/schedule     — { datetime, filename, caption }
 *   GET  /api/schedule     — pending schedule list
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWriteStream } from 'node:fs'
import { readdir, readFile, stat, mkdir } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { createJsonFileStore } from '../utils/json-file-store.js'
import {
  runIgPostScript,
  runIgPostRemoteFile,
  resolveRemoteVideosPath,
  IG_VIDEOS_DIR,
} from '../bot/commands/ig-post.js'
import { addEntry, getPending, type IgScheduleEntry } from '../bot/commands/ig-schedule-store.js'
import { getPairings } from '../remote/pairing-store.js'
import { remoteToolCall } from '../remote/relay-client.js'
import { env } from '../config/env.js'

const PAGE_PATH = join(process.cwd(), 'src', 'dashboard', 'web', 'ig-quickpost.html')
const UPLOAD_SUBDIR = '上傳'
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 // 1 GB
const MEDIA_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.jpg', '.jpeg', '.png'])

// --- Caption templates ---

interface CaptionTemplate {
  readonly name: string
  readonly content: string
}

const templateStore = createJsonFileStore<CaptionTemplate[]>(
  resolve('data/ig-caption-templates.json'),
  () => [],
)

// --- In-memory job store ---

interface IgJob {
  readonly id: string
  readonly filename: string
  readonly status: 'running' | 'done' | 'failed'
  readonly result: { success: boolean; duration_s: number; error?: string; step?: string } | null
  readonly startedAt: number
}

const jobs = new Map<string, IgJob>()
const JOB_TTL_MS = 60 * 60 * 1000

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id)
  }
}

// --- Helpers ---

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) { req.destroy(); rej(new Error('Body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => res(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', rej)
  })
}

/** Constant-time token check against IG_WEB_TOKEN. */
function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const provided = (req.headers['x-ig-token'] as string | undefined) ?? url.searchParams.get('token') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Resolve a path safely inside IG_VIDEOS_DIR (no traversal). */
function safePath(rel: string): string | null {
  const resolved = resolve(IG_VIDEOS_DIR, rel)
  const base = resolve(IG_VIDEOS_DIR)
  if (resolved !== base && !resolved.startsWith(base + '\\') && !resolved.startsWith(base + '/')) {
    return null
  }
  return resolved
}

function sanitizeName(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim()
}

// --- Readiness status ---

interface MachineStatus {
  readonly label: string
  readonly ready: boolean
  readonly hint: string | null
}

interface IgWebStatus {
  readonly ready: boolean // at least one machine can post
  readonly machines: readonly MachineStatus[]
  readonly hint: string | null
}

// Probing the relay costs round-trips — cache for 10s so UI polling is cheap
let statusCache: { value: IgWebStatus; ts: number } | null = null
const STATUS_CACHE_MS = 10_000

/**
 * Every paired machine = one IG account (its CDP Chrome's login).
 * Probe each in parallel so the page can offer "post from which machine".
 */
async function checkStatus(): Promise<IgWebStatus> {
  if (statusCache && Date.now() - statusCache.ts < STATUS_CACHE_MS) {
    return statusCache.value
  }

  const pairings = env.ADMIN_CHAT_ID ? getPairings(env.ADMIN_CHAT_ID, undefined) : []
  const machines: MachineStatus[] = await Promise.all(
    pairings.map(async (p): Promise<MachineStatus> => {
      const label = p.label ?? p.code
      if (!p.connected) {
        return { label, ready: false, hint: '未連線 — 開該機器的 client 或 /pair' }
      }
      try {
        await remoteToolCall(p.code, 'remote_system_info', {}, 6_000)
        return { label, ready: true, hint: null }
      } catch {
        return { label, ready: false, hint: '配對在但 agent 沒回應 — /rpair 重啟' }
      }
    }),
  )

  const anyReady = machines.some((m) => m.ready)
  const status: IgWebStatus = {
    ready: anyReady,
    machines,
    hint: anyReady
      ? null
      : machines.length === 0
        ? '沒有配對任何機器 — 先在 Telegram /pair'
        : '所有機器都離線 — 開機器的 ClaudeBot client（或 /rpair）',
  }

  statusCache = { value: status, ts: Date.now() }
  return status
}

/** Readiness of one specific machine (or any, when label omitted). */
async function isMachineReady(machine?: string): Promise<{ ok: boolean; hint: string | null }> {
  const status = await checkStatus()
  if (!machine) return { ok: status.ready, hint: status.hint }
  const m = status.machines.find((x) => x.label === machine)
  if (!m) return { ok: false, hint: `機器 ${machine} 不在配對清單` }
  return { ok: m.ready, hint: m.hint }
}

// --- Route handlers ---

/** Browse a REMOTE machine's ~/Videos via remote_list_directory. */
async function handleVideosRemote(machine: string, dir: string, res: ServerResponse): Promise<void> {
  const pairing = env.ADMIN_CHAT_ID
    ? getPairings(env.ADMIN_CHAT_ID, undefined).find((p) => (p.label ?? p.code) === machine)
    : null
  if (!pairing?.connected) {
    sendJson(res, { error: `機器 ${machine} 未連線` }, 503)
    return
  }

  let raw: string
  try {
    const path = await resolveRemoteVideosPath(pairing.code, dir)
    raw = await remoteToolCall(pairing.code, 'remote_list_directory', { path }, 15_000)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 502)
    return
  }

  // Lines look like: [file] name (2026-06-06 10:30, 23.8MB) / [dir] name (2026-06-06 10:30)
  const SIZE_MULT: Record<string, number> = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }
  const dirs: string[] = []
  const files: Array<{ name: string; size: number; mtime: number }> = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\[(dir|file)\] (.+?) \((\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:, ([\d.]+)(B|KB|MB|GB))?\)\s*$/)
    if (!m) continue
    if (m[1] === 'dir') { dirs.push(m[2]); continue }
    const ext = m[2].slice(m[2].lastIndexOf('.')).toLowerCase()
    if (!MEDIA_EXTS.has(ext)) continue
    files.push({
      name: m[2],
      size: Math.round(parseFloat(m[4] ?? '0') * (SIZE_MULT[m[5] ?? 'B'] ?? 1)),
      mtime: Date.parse(m[3]) || 0,
    })
  }
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime)
  sendJson(res, { dir, dirs, files: sorted, machine })
}

async function handleVideos(url: URL, res: ServerResponse): Promise<void> {
  const machine = url.searchParams.get('machine')
  const dir = url.searchParams.get('dir') ?? ''
  if (machine) {
    await handleVideosRemote(machine, dir, res)
    return
  }
  const dirPath = dir ? safePath(dir) : IG_VIDEOS_DIR
  if (!dirPath) { sendJson(res, { error: 'bad dir' }, 400); return }

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    sendJson(res, { error: 'dir not found' }, 404)
    return
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const mediaEntries = entries.filter(
    (e) => e.isFile() && MEDIA_EXTS.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase()),
  )
  const files = await Promise.all(
    mediaEntries.map(async (e) => {
      const s = await stat(join(dirPath, e.name)).catch(() => null)
      return { name: e.name, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
    }),
  )
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime)
  sendJson(res, { dir, dirs, files: sorted })
}

function handleUpload(req: IncomingMessage, url: URL, res: ServerResponse): void {
  const rawName = url.searchParams.get('name') ?? ''
  const name = sanitizeName(rawName)
  if (!name) { sendJson(res, { error: 'name required' }, 400); return }

  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_UPLOAD_BYTES) { sendJson(res, { error: 'file too large (max 1GB)' }, 413); return }

  const uploadDir = join(IG_VIDEOS_DIR, UPLOAD_SUBDIR)
  mkdir(uploadDir, { recursive: true })
    .then(() => {
      const target = join(uploadDir, name)
      const out = createWriteStream(target)
      let written = 0

      req.on('data', (chunk: Buffer) => {
        written += chunk.length
        if (written > MAX_UPLOAD_BYTES) {
          req.destroy()
          out.destroy()
          sendJson(res, { error: 'file too large (max 1GB)' }, 413)
        }
      })
      req.pipe(out)
      out.on('finish', () => {
        sendJson(res, { saved: `${UPLOAD_SUBDIR}/${name}`, size: written })
      })
      out.on('error', (err) => sendJson(res, { error: err.message }, 500))
    })
    .catch((err: Error) => sendJson(res, { error: err.message }, 500))
}

const PostSchema = z.object({
  filename: z.string().min(1).max(500).optional(), // file on A (will be transferred)
  remoteFile: z.string().min(1).max(500).optional(), // file already on the machine, rel to ~/Videos
  caption: z.string().min(1).max(2200), // IG caption hard limit
  machine: z.string().max(100).optional(), // pairing label = which IG account
})

async function handlePost(body: string, res: ServerResponse): Promise<void> {
  const parsed = PostSchema.safeParse(JSON.parse(body))
  if (!parsed.success || (!parsed.data.filename && !parsed.data.remoteFile)) {
    sendJson(res, { error: '需要 filename（或 remoteFile）+ caption' }, 400)
    return
  }
  const { filename, remoteFile, caption, machine } = parsed.data
  if (remoteFile && !machine) {
    sendJson(res, { error: '遠端檔案需要指定 machine' }, 400)
    return
  }

  // Hard gate: without the remote machine, the local fallback would launch
  // A's CDP Chrome (not logged into IG) and die mid-flow with a confusing error
  const gate = await isMachineReady(machine)
  if (!gate.ok) {
    sendJson(res, { error: gate.hint ?? '遠端機器未連線' }, 503)
    return
  }

  pruneJobs()
  const id = randomBytes(4).toString('hex')
  const display = remoteFile ?? filename ?? ''
  jobs.set(id, { id, filename: display, status: 'running', result: null, startedAt: Date.now() })

  // Fire and poll — the CDP flow takes minutes.
  // remoteFile → zero-transfer (file already on the posting machine)
  const run = remoteFile
    ? runIgPostRemoteFile(machine!, remoteFile, caption, env.ADMIN_CHAT_ID ?? 0)
    : runIgPostScript(filename!, caption, env.ADMIN_CHAT_ID, machine)
  run
    .then((result) => {
      jobs.set(id, { id, filename: display, status: result.success ? 'done' : 'failed', result, startedAt: Date.now() })
    })
    .catch((err) => {
      jobs.set(id, {
        id, filename: display, status: 'failed',
        result: { success: false, duration_s: 0, error: err instanceof Error ? err.message : String(err) },
        startedAt: Date.now(),
      })
    })

  sendJson(res, { jobId: id }, 202)
}

const ScheduleSchema = z.object({
  datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
  filename: z.string().min(1).max(500).optional(),
  remoteFile: z.string().min(1).max(500).optional(),
  caption: z.string().min(1).max(2200),
  machine: z.string().max(100).optional(),
})

async function handleSchedule(body: string, res: ServerResponse): Promise<void> {
  const parsed = ScheduleSchema.safeParse(JSON.parse(body))
  if (!parsed.success || (!parsed.data.filename && !parsed.data.remoteFile)) {
    sendJson(res, { error: '需要 datetime + filename（或 remoteFile）+ caption' }, 400)
    return
  }
  const { datetime, filename, remoteFile, caption, machine } = parsed.data
  if (remoteFile && !machine) {
    sendJson(res, { error: '遠端檔案需要指定 machine' }, 400)
    return
  }

  const scheduled = new Date(datetime)
  if (isNaN(scheduled.getTime()) || scheduled.getTime() <= Date.now()) {
    sendJson(res, { error: '排程時間必須是未來' }, 400)
    return
  }

  // Local files are verified now; remote files are checked at fire time
  // (the machine may be offline right now — that's fine for a future post)
  if (!remoteFile) {
    const fullPath = safePath(filename!)
    if (!fullPath) { sendJson(res, { error: '無效路徑' }, 400); return }
    try {
      await stat(fullPath)
    } catch {
      sendJson(res, { error: `找不到檔案: ${filename}` }, 404)
      return
    }
  }

  const entry: IgScheduleEntry = {
    id: randomBytes(4).toString('hex'),
    chatId: env.ADMIN_CHAT_ID ?? 0,
    datetime,
    filename: remoteFile ?? filename ?? '',
    caption,
    status: 'pending',
    createdAt: new Date().toISOString(),
    result: null,
    ...(machine ? { machine } : {}),
    ...(remoteFile ? { remotePath: remoteFile } : {}),
  }
  addEntry(entry)
  sendJson(res, { scheduled: entry.id, datetime }, 201)
}

const TemplateSchema = z.object({
  name: z.string().min(1).max(50),
  content: z.string().min(1).max(2200),
})

function handleTemplates(method: string, url: URL, body: string, res: ServerResponse): void {
  if (method === 'GET') {
    sendJson(res, { templates: templateStore.load() })
    return
  }
  if (method === 'POST') {
    const parsed = TemplateSchema.safeParse(JSON.parse(body))
    if (!parsed.success) { sendJson(res, { error: '需要 name + content' }, 400); return }
    const existing = templateStore.load().filter((t) => t.name !== parsed.data.name)
    templateStore.save([...existing, parsed.data])
    sendJson(res, { saved: parsed.data.name }, 201)
    return
  }
  if (method === 'DELETE') {
    const name = url.searchParams.get('name') ?? ''
    templateStore.save(templateStore.load().filter((t) => t.name !== name))
    sendJson(res, { deleted: name })
    return
  }
  sendJson(res, { error: 'method not allowed' }, 405)
}

// --- Server ---

export function startIgWebServer(port: number, token: string): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    try {
      // Page (no token — the page itself asks for the PIN before calling APIs)
      if (path === '/' && req.method === 'GET') {
        const html = await readFile(PAGE_PATH)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(html)
        return
      }

      if (!path.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Everything under /api/ requires the token
      if (!isAuthorized(req, url, token)) {
        sendJson(res, { error: 'unauthorized' }, 401)
        return
      }

      if (path === '/api/status' && req.method === 'GET') { sendJson(res, await checkStatus()); return }
      if (path === '/api/videos' && req.method === 'GET') { await handleVideos(url, res); return }
      if (path === '/api/upload' && req.method === 'PUT') { handleUpload(req, url, res); return }
      if (path === '/api/templates') {
        const body = req.method === 'POST' ? await readBody(req) : ''
        handleTemplates(req.method ?? 'GET', url, body, res)
        return
      }
      if (path === '/api/post' && req.method === 'POST') { await handlePost(await readBody(req), res); return }
      if (path === '/api/job' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('id') ?? '')
        if (job) sendJson(res, { job })
        else sendJson(res, { error: 'job not found' }, 404)
        return
      }
      if (path === '/api/schedule' && req.method === 'POST') { await handleSchedule(await readBody(req), res); return }
      if (path === '/api/schedule' && req.method === 'GET') {
        const pending = getPending()
        sendJson(res, { schedule: [...pending].sort((a, b) => a.datetime.localeCompare(b.datetime)) })
        return
      }

      sendJson(res, { error: 'not found' }, 404)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, { error: msg }, 500)
    }
  })

  server.listen(port, () => {
    console.log(`[ig-web] IG quick-post server at http://localhost:${port}`)
  })
}
