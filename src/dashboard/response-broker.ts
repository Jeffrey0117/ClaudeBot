import { writeFile, readFile, unlink, readdir, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const RESPONSE_DIR = join(process.cwd(), 'data', 'responses')
const POLL_INTERVAL_MS = 300
const STALE_MS = 60_000
// Run the stale-file sweep (a per-file stat() of every response file) only
// every Nth poll instead of every 300ms — at POLL_INTERVAL_MS that's ~once a
// minute, which is plenty for cleaning abandoned chunk files and removes the
// second full readdir+stat pass from the hot path.
const STALE_SWEEP_EVERY = 200
let pollCount = 0

export interface ResponseChunkEvent {
  readonly type: 'response_chunk'
  readonly commandId: string
  readonly delta: string
  readonly accumulated: string
}

export interface ResponseCompleteEvent {
  readonly type: 'response_complete'
  readonly commandId: string
  readonly text: string
  readonly botId: string
  readonly cost: number
  readonly duration: number
}

export interface ResponseErrorEvent {
  readonly type: 'response_error'
  readonly commandId: string
  readonly error: string
}

export type ResponseEvent = ResponseChunkEvent | ResponseCompleteEvent | ResponseErrorEvent

async function ensureDir(): Promise<void> {
  await mkdir(RESPONSE_DIR, { recursive: true })
}

function eventFilePath(commandId: string): string {
  const safe = commandId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(RESPONSE_DIR, `${safe}.json`)
}

// --- Writer side (called from bot process / queue-processor) ---

async function writeEvent(event: ResponseEvent): Promise<void> {
  try {
    await ensureDir()
    await writeFile(eventFilePath(event.commandId), JSON.stringify(event), 'utf-8')
  } catch {
    // best-effort
  }
}

export function emitResponseChunk(commandId: string, delta: string, accumulated: string): void {
  const event: ResponseChunkEvent = { type: 'response_chunk', commandId, delta, accumulated }
  writeEvent(event).catch((err) => console.error('[response-broker] chunk write failed:', err))
}

export function emitResponseComplete(
  commandId: string,
  text: string,
  botId: string,
  cost: number,
  duration: number,
): void {
  const event: ResponseCompleteEvent = { type: 'response_complete', commandId, text, botId, cost, duration }
  writeEvent(event).catch((err) => console.error('[response-broker] complete write failed:', err))
}

export function emitResponseError(commandId: string, error: string): void {
  const event: ResponseErrorEvent = { type: 'response_error', commandId, error }
  writeEvent(event).catch((err) => console.error('[response-broker] error write failed:', err))
}

// --- Reader side (called from dashboard server process) ---

type EventCallback = (event: ResponseEvent) => void
const listeners: EventCallback[] = []
let pollTimer: ReturnType<typeof setInterval> | null = null
const seenEvents = new Map<string, string>() // commandId → last seen type+accumulated length

async function pollEvents(): Promise<void> {
  try {
    const files = await readdir(RESPONSE_DIR)
    const jsonFiles = files.filter((f) => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const filePath = join(RESPONSE_DIR, file)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const event = JSON.parse(raw) as ResponseEvent

        // Dedup: skip if we already dispatched this exact state
        const fingerprint = event.type === 'response_chunk'
          ? `chunk:${event.accumulated.length}`
          : event.type
        const lastSeen = seenEvents.get(event.commandId)
        if (lastSeen === fingerprint) continue
        seenEvents.set(event.commandId, fingerprint)

        for (const fn of listeners) {
          fn(event)
        }

        // Clean up completed/error event files
        if (event.type === 'response_complete' || event.type === 'response_error') {
          await unlink(filePath).catch(() => {})
          seenEvents.delete(event.commandId)
        }
      } catch {
        // skip malformed files
      }
    }

    // Evict oldest entries when map grows too large (LRU-style)
    while (seenEvents.size > 500) {
      const oldest = seenEvents.keys().next().value
      if (oldest !== undefined) seenEvents.delete(oldest)
      else break
    }

    // Clean up stale chunk files older than STALE_MS — only on the periodic
    // sweep, not on every 300ms poll.
    if (++pollCount % STALE_SWEEP_EVERY === 0) {
      const now = Date.now()
      for (const file of jsonFiles) {
        try {
          const filePath = join(RESPONSE_DIR, file)
          const fileStat = await stat(filePath)
          if (now - fileStat.mtimeMs > STALE_MS) {
            await unlink(filePath).catch(() => {})
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    // directory might not exist yet
  }
}

export function onResponseEvent(callback: EventCallback): () => void {
  listeners.push(callback)

  // Start polling on first listener
  if (!pollTimer) {
    ensureDir().catch(() => {})
    pollTimer = setInterval(pollEvents, POLL_INTERVAL_MS)
  }

  return () => {
    const idx = listeners.indexOf(callback)
    if (idx !== -1) listeners.splice(idx, 1)
    if (listeners.length === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}
