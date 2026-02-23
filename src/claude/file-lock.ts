import { writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'

const LOCK_FILE = '.claudebot.lock'
const POLL_INTERVAL_MS = 2_000
const STALE_TIMEOUT_MS = 35 * 60 * 1000 // 35 min (longer than Claude 30min timeout)

interface LockInfo {
  readonly botToken: string
  readonly pid: number
  readonly startedAt: number
}

function lockPath(projectPath: string): string {
  return join(projectPath, LOCK_FILE)
}

function botId(): string {
  // Last 6 chars of token as identifier
  return env.BOT_TOKEN.slice(-6)
}

function isOurLock(info: LockInfo): boolean {
  return info.botToken === botId() && info.pid === process.pid
}

async function readLock(projectPath: string): Promise<LockInfo | null> {
  try {
    const raw = await readFile(lockPath(projectPath), 'utf-8')
    return JSON.parse(raw) as LockInfo
  } catch {
    return null
  }
}

function isStale(info: LockInfo): boolean {
  return Date.now() - info.startedAt > STALE_TIMEOUT_MS
}

export async function acquireLock(projectPath: string): Promise<boolean> {
  const existing = await readLock(projectPath)

  if (existing) {
    if (isOurLock(existing)) return true
    if (isStale(existing)) {
      // Stale lock from crashed process, take over
      await releaseLock(projectPath)
    } else {
      return false
    }
  }

  const info: LockInfo = {
    botToken: botId(),
    pid: process.pid,
    startedAt: Date.now(),
  }

  await writeFile(lockPath(projectPath), JSON.stringify(info), 'utf-8')
  return true
}

export async function releaseLock(projectPath: string): Promise<void> {
  try {
    await unlink(lockPath(projectPath))
  } catch {
    // Already deleted, fine
  }
}

export async function getLockHolder(projectPath: string): Promise<string | null> {
  const info = await readLock(projectPath)
  if (!info || isStale(info)) return null
  if (isOurLock(info)) return null
  return `bot ...${info.botToken}`
}

export async function waitForLock(
  projectPath: string,
  onWaiting?: (holder: string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error('Lock acquisition aborted')
    }

    const acquired = await acquireLock(projectPath)
    if (acquired) return

    const holder = await getLockHolder(projectPath)
    if (holder && onWaiting) {
      onWaiting(holder)
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS)
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Lock acquisition aborted'))
        }, { once: true })
      }
    })
  }
}
