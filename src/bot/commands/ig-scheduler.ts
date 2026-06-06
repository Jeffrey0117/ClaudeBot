/**
 * IG Scheduler — checks every 60s for due posts and executes them.
 * Posting runs through the CDP engine (runIgPostScript → ig-cdp-flow).
 * Concurrency lock ensures only one post runs at a time (single IG tab).
 */

import { getPending, updateEntry, cleanupOldEntries } from './ig-schedule-store.js'
import { runIgPostScript } from './ig-post.js'

let schedulerInterval: NodeJS.Timeout | null = null
let sendFn: ((chatId: number, text: string) => Promise<void>) | null = null
let isPosting = false

/** Inject a function to send Telegram messages. */
export function setIgSchedulerSendFn(fn: typeof sendFn): void {
  sendFn = fn
}

async function executeDuePost(entry: {
  readonly id: string
  readonly chatId: number
  readonly filename: string
  readonly caption: string
}): Promise<void> {
  updateEntry(entry.id, { status: 'posting' })

  try {
    const result = await runIgPostScript(entry.filename, entry.caption)
    updateEntry(entry.id, { status: result.success ? 'done' : 'failed', result })

    if (sendFn) {
      const msg = result.success
        ? `✅ IG 排程發文成功\n📁 ${entry.filename}\n⏱ ${result.duration_s}s`
        : `❌ IG 排程發文失敗\n📁 ${entry.filename}\n${result.error ?? 'Unknown error'}`
      await sendFn(entry.chatId, msg)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    updateEntry(entry.id, {
      status: 'failed',
      result: { success: false, duration_s: 0, error: errorMsg },
    })

    if (sendFn) {
      await sendFn(entry.chatId, `❌ IG 排程發文異常\n📁 ${entry.filename}\n${errorMsg}`)
    }
  }
}

async function processQueue(): Promise<void> {
  if (isPosting) return

  const now = new Date()
  const pending = getPending()
  const due = pending.filter((e) => new Date(e.datetime) <= now)

  for (const entry of due) {
    isPosting = true
    try {
      await executeDuePost(entry)
    } finally {
      isPosting = false
    }
  }
}

function checkSchedule(): void {
  processQueue().catch((err) => {
    console.error('[ig-scheduler] processQueue failed:', err)
  })
}

export function startIgScheduler(): void {
  if (schedulerInterval) return

  cleanupOldEntries()
  checkSchedule()
  schedulerInterval = setInterval(checkSchedule, 60_000)
}

export function stopIgScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
}
