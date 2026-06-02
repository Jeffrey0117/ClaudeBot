import { open, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_FILE = join(process.cwd(), 'data', 'commands.lock')
const STALE_MS = 10_000

interface LockInfo {
  readonly holder: string
  readonly pid: number
  readonly acquiredAt: number
}

async function tryCreateLock(holder: string): Promise<boolean> {
  // 'wx' fails atomically with EEXIST if the file already exists — so concurrent
  // pollers never open the same file for writing at once (which on Windows raised
  // EPERM sharing violations with the old read-then-writeFile approach).
  try {
    const fh = await open(LOCK_FILE, 'wx')
    const info: LockInfo = { holder, pid: process.pid, acquiredAt: Date.now() }
    await fh.writeFile(JSON.stringify(info), 'utf-8')
    await fh.close()
    return true
  } catch {
    return false
  }
}

export async function acquireCommandLock(holder: string): Promise<boolean> {
  if (await tryCreateLock(holder)) return true

  // Lock exists — only steal it if it's stale.
  try {
    const raw = await readFile(LOCK_FILE, 'utf-8')
    const info = JSON.parse(raw) as LockInfo
    if (Date.now() - info.acquiredAt < STALE_MS) {
      return false
    }
  } catch {
    // Unreadable / partial write in progress — let it be, retry next poll.
    return false
  }

  // Stale lock: remove and attempt to re-create. If another poller wins the race,
  // tryCreateLock returns false and we simply skip this cycle.
  try {
    await unlink(LOCK_FILE)
  } catch {
    // Already removed by another poller.
  }
  return tryCreateLock(holder)
}

export async function releaseCommandLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE)
  } catch {
    // Already deleted
  }
}
