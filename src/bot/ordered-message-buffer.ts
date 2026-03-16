/**
 * Ordered Message Buffer (OMB)
 *
 * Ensures text + voice messages reach the AI queue in the exact order
 * the user sent them, regardless of voice processing latency.
 *
 * Each chat/thread has a buffer keyed by Telegram message_id (guaranteed ascending).
 * When a voice message is pending, all subsequent messages are held until
 * it resolves. Consecutive ready entries are merged and flushed as one prompt.
 */

import { getUserState, onProjectSwitch } from './state.js'
import { resolveBackend } from '../ai/types.js'
import { getAISessionId } from '../ai/session-store.js'
import { enqueue, isProcessing, getQueueLength } from '../claude/queue.js'
import { recordActivity } from '../plugins/stats/activity-logger.js'
import { getPairing } from '../remote/pairing-store.js'
import { getPluginModule } from '../plugins/loader.js'

// Allot rejection notification callback (wired from bot.ts)
type NotifyFn = (chatId: number, text: string) => void
let allotRejectNotifyFn: NotifyFn = () => {}
export function setAllotRejectNotify(fn: NotifyFn): void {
  allotRejectNotifyFn = fn
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BufferEntry {
  readonly messageId: number
  readonly type: 'text' | 'voice'
  readonly chatId: number
  readonly threadId: number | undefined
  readonly timestamp: number
  status: 'pending' | 'ready' | 'failed'
  text: string | null
  replyQuote: string
}

interface ChatBuffer {
  readonly entries: Map<number, BufferEntry>
  flushTimer: ReturnType<typeof setTimeout> | null
  voiceActive: number
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const buffers = new Map<string, ChatBuffer>()

const TEXT_COLLECT_MS = 1_000
const STALE_MS = 30_000
const STALE_CHECK_MS = 30_000

/** Build a composite key that isolates forum topics within the same chat. */
function bufferKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`
}

/** Periodic staleness sweep — force-flush buffers older than 30 s. */
const staleTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, buf] of buffers) {
    if (buf.entries.size === 0) continue

    let oldest = Infinity
    for (const e of buf.entries.values()) {
      if (e.timestamp < oldest) oldest = e.timestamp
    }

    if (now - oldest > STALE_MS) {
      forceFlushByKey(key)
    }
  }
}, STALE_CHECK_MS)
staleTimer.unref()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrCreate(key: string): ChatBuffer {
  let buf = buffers.get(key)
  if (!buf) {
    buf = { entries: new Map(), flushTimer: null, voiceActive: 0 }
    buffers.set(key, buf)
  }
  return buf
}

function resetTimer(key: string, buf: ChatBuffer): void {
  if (buf.flushTimer) clearTimeout(buf.flushTimer)
  buf.flushTimer = setTimeout(() => {
    buf.flushTimer = null
    tryFlushByKey(key)
  }, TEXT_COLLECT_MS)
}

/**
 * Build a combined prompt from a list of entries and enqueue it.
 * Uses the first non-empty replyQuote found (entries may arrive out of add-order).
 */
function flushEntries(entries: readonly BufferEntry[]): void {
  if (entries.length === 0) return

  const first = entries[0]
  const chatId = first.chatId
  const threadId = first.threadId

  const state = getUserState(chatId, threadId)

  // Resolve project: local selection or remote pairing fallback
  const pairing = !state.selectedProject ? getPairing(chatId, threadId) : null
  const project = state.selectedProject
    ?? (pairing?.connected ? { name: 'remote', path: process.cwd() } : null)
  if (!project) return

  // Allot gate: check quota for remote requests
  if (project.name === 'remote') {
    const allotMod = getPluginModule('allot') as Record<string, unknown> | undefined
    if (allotMod?.tryReserve) {
      const check = (allotMod.tryReserve as (c: number, t: number | undefined) => { allowed: boolean; reason?: string; warningLevel?: number })(chatId, threadId)
      if (!check.allowed) {
        allotRejectNotifyFn(chatId, check.reason ?? '\u{23F3} \u{984D}\u{5EA6}\u{5DF2}\u{7528}\u{5B8C}')
        return
      }
      if (check.warningLevel) {
        const warnMsg = check.warningLevel >= 95
          ? '\u{1F534} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{5373}\u{5C07}\u{7528}\u{5B8C} (95%)'
          : check.warningLevel >= 85
            ? '\u{1F7E1} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{4F7F}\u{7528}\u{5DF2}\u{9054} 85%'
            : '\u{1F4CA} \u{672C}\u{9031}\u{984D}\u{5EA6}\u{4F7F}\u{7528}\u{5DF2}\u{9054} 70%'
        allotRejectNotifyFn(chatId, warnMsg)
      }
    }
  }

  // Combine texts — skip failed entries (no text)
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.status === 'failed' || !entry.text) continue
    const prefix = entry.type === 'voice' ? '[語音輸入] ' : ''
    parts.push(prefix + entry.text)
  }

  if (parts.length === 0) return

  const quote = entries.find((e) => e.replyQuote)?.replyQuote ?? ''
  const combined = quote + parts.join('\n\n')

  recordActivity({
    timestamp: Date.now(),
    type: 'message_sent',
    project: project.name,
    promptLength: combined.length,
  })

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
  enqueue({
    chatId,
    threadId,
    prompt: combined,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })
}

// ---------------------------------------------------------------------------
// Internal flush operations (by composite key)
// ---------------------------------------------------------------------------

function tryFlushByKey(key: string): void {
  const buf = buffers.get(key)
  if (!buf || buf.entries.size === 0) return

  const sorted = [...buf.entries.keys()].sort((a, b) => a - b)
  const batch: BufferEntry[] = []

  for (const msgId of sorted) {
    const entry = buf.entries.get(msgId)!
    if (entry.status === 'pending') break
    batch.push(entry)
    buf.entries.delete(msgId)
  }

  if (batch.length > 0) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer)
      buf.flushTimer = null
    }
    flushEntries(batch)
  }

  if (buf.entries.size === 0 && buf.voiceActive <= 0) {
    buffers.delete(key)
  }
}

/** Max age for a pending voice entry before force-deletion (prevents leak). */
const PENDING_MAX_AGE_MS = 60_000

function forceFlushByKey(key: string): void {
  const buf = buffers.get(key)
  if (!buf || buf.entries.size === 0) return

  if (buf.flushTimer) {
    clearTimeout(buf.flushTimer)
    buf.flushTimer = null
  }

  const sorted = [...buf.entries.keys()].sort((a, b) => a - b)
  const batch: BufferEntry[] = []
  const now = Date.now()

  for (const msgId of sorted) {
    const entry = buf.entries.get(msgId)!
    if (entry.status === 'ready') {
      batch.push(entry)
      buf.entries.delete(msgId)
    } else if (entry.status === 'failed') {
      buf.entries.delete(msgId)
    } else if (entry.status === 'pending') {
      // Force-delete stale pending entries to prevent memory leak
      if (now - entry.timestamp > PENDING_MAX_AGE_MS) {
        buf.entries.delete(msgId)
        buf.voiceActive = Math.max(0, buf.voiceActive - 1)
      }
      // Otherwise keep — voice transcription may still be running
    }
  }

  // Only clean up buffer if truly empty (no pending voice entries)
  if (buf.entries.size === 0) {
    buf.voiceActive = 0
    buffers.delete(key)
  }

  if (batch.length > 0) {
    flushEntries(batch)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QueueStatus {
  readonly isProcessing: boolean
  readonly queueLength: number
  readonly projectName: string
}

/**
 * Add a text message to the buffer.
 * Returns queue status for the caller to display queue hints.
 */
export function addText(
  chatId: number,
  messageId: number,
  threadId: number | undefined,
  text: string,
  replyQuote: string,
): QueueStatus | null {
  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) return null

  const key = bufferKey(chatId, threadId)
  const buf = getOrCreate(key)
  buf.entries.set(messageId, {
    messageId,
    type: 'text',
    chatId,
    threadId,
    timestamp: Date.now(),
    status: 'ready',
    text,
    replyQuote,
  })

  resetTimer(key, buf)

  const project = state.selectedProject
  return {
    isProcessing: isProcessing(project.path),
    queueLength: getQueueLength(project.path),
    projectName: project.name,
  }
}

/**
 * Add a voice message placeholder to the buffer.
 * Returns a `resolveVoice` callback that the caller invokes when ASR finishes.
 */
export function addVoice(
  chatId: number,
  messageId: number,
  threadId: number | undefined,
  replyQuote = '',
): (text: string | null) => void {
  const key = bufferKey(chatId, threadId)
  const buf = getOrCreate(key)
  buf.voiceActive++
  buf.entries.set(messageId, {
    messageId,
    type: 'voice',
    chatId,
    threadId,
    timestamp: Date.now(),
    status: 'pending',
    text: null,
    replyQuote,
  })

  return (text: string | null) => {
    // Look up fresh buffer reference — may have been cleared/replaced
    const currentBuf = buffers.get(key)
    if (!currentBuf) return

    const entry = currentBuf.entries.get(messageId)
    if (!entry) return

    currentBuf.voiceActive = Math.max(0, currentBuf.voiceActive - 1)

    if (text) {
      entry.status = 'ready'
      entry.text = text
    } else {
      entry.status = 'failed'
    }

    tryFlushByKey(key)
  }
}

/**
 * Scan from buffer head (lowest messageId). Flush consecutive ready/failed
 * entries until we hit a pending one. Failed entries are skipped (not blocking).
 */
export function tryFlush(chatId: number, threadId?: number): void {
  tryFlushByKey(bufferKey(chatId, threadId))
}

/**
 * Clear the entire buffer for a chat (steer mode / cancel).
 * Pending voice entries are discarded.
 */
export function clearBuffer(chatId: number, threadId?: number): void {
  const key = bufferKey(chatId, threadId)
  const buf = buffers.get(key)
  if (!buf) return

  if (buf.flushTimer) clearTimeout(buf.flushTimer)
  buf.entries.clear()
  buf.voiceActive = 0
  buffers.delete(key)
}

/**
 * Force-flush everything that's ready, discard pending entries.
 * Used on project switch and staleness timeout.
 */
export function forceFlush(chatId: number, threadId?: number): void {
  forceFlushByKey(bufferKey(chatId, threadId))
}

/**
 * Force-flush all buffers belonging to a chatId (all threads).
 * Used by onProjectSwitch hook where threadId is unknown.
 */
function forceFlushAllThreads(chatId: number): void {
  const prefix = `${chatId}`
  for (const key of [...buffers.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`)) {
      forceFlushByKey(key)
    }
  }
}

/**
 * Return the number of voice messages currently being processed for a chat.
 * Used for graceful degradation (skip Gemini when >= 2).
 */
export function getVoiceActive(chatId: number, threadId?: number): number {
  return buffers.get(bufferKey(chatId, threadId))?.voiceActive ?? 0
}

// ---------------------------------------------------------------------------
// Hook: flush buffer on project switch (breaks circular dep with state.ts)
// ---------------------------------------------------------------------------
onProjectSwitch(forceFlushAllThreads)
