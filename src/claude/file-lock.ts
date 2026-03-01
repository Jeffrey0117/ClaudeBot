import { writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'

const LOCK_FILE = '.claudebot.lock'
const POLL_INTERVAL_MS = 2_000
const STALE_TIMEOUT_MS = 35 * 60 * 1000 // 35 min (longer than Claude 30min timeout)

interface LockInfo {
  readonly botToken: string
  readonly botLabel: string
  readonly pid: number
  readonly startedAt: number
  readonly task?: string
}

function lockPath(projectPath: string): string {
  return join(projectPath, LOCK_FILE)
}

function botId(): string {
  // Last 6 chars of token as identifier
  return env.BOT_TOKEN.slice(-6)
}

function botLabel(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'Main Bot'
  // .env.bot2 → "Bot 2", .env.bot3 → "Bot 3"
  const num = envArg.match(/\.env\.bot(\d+)/)?.[1]
  return num ? `Bot ${num}` : envArg.replace('.env.', 'Bot ')
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isStale(info: LockInfo): boolean {
  if (Date.now() - info.startedAt > STALE_TIMEOUT_MS) return true
  // If the holding process is dead, the lock is stale
  if (!isPidAlive(info.pid)) return true
  return false
}

export async function acquireLock(projectPath: string, task?: string): Promise<boolean> {
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
    botLabel: botLabel(),
    pid: process.pid,
    startedAt: Date.now(),
    ...(task ? { task } : {}),
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
  const name = info.botLabel || `Bot ...${info.botToken}`
  return info.task ? `${name} (${info.task})` : name
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
