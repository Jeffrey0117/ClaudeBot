import { writeFile, readFile, unlink, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const RESPONSE_DIR = join(process.cwd(), 'data', 'responses')
const POLL_INTERVAL_MS = 300
const STALE_MS = 60_000

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
  writeEvent(event)
}

export function emitResponseComplete(
  commandId: string,
  text: string,
  botId: string,
  cost: number,
  duration: number,
): void {
  const event: ResponseCompleteEvent = { type: 'response_complete', commandId, text, botId, cost, duration }
  writeEvent(event)
}

export function emitResponseError(commandId: string, error: string): void {
  const event: ResponseErrorEvent = { type: 'response_error', commandId, error }
  writeEvent(event)
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

    // Clean up stale entries from seenEvents map
    if (seenEvents.size > 500) {
      seenEvents.clear()
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
