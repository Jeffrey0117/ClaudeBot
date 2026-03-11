import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getQueueLength, getActiveProjectPaths } from '../claude/queue.js'
import { getLockHolder } from '../claude/file-lock.js'
import { scanProjects } from '../config/projects.js'
import { getAnyElapsedMs } from '../ai/registry.js'
import { getActiveRunnerInfos } from './runner-tracker.js'
import type { BotHeartbeat } from './types.js'

const HEARTBEAT_INTERVAL_MS = 2_000
const HEARTBEAT_DIR = join(process.cwd(), 'data', 'heartbeat')

let timer: ReturnType<typeof setInterval> | null = null

function deriveBotId(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'bot1'
  // .env.bot2 → bot2
  return envArg.replace('.env.', '')
}

async function writeHeartbeat(botId: string): Promise<void> {
  const activeProjectPaths = getActiveProjectPaths()
  const projects = scanProjects()

  // Build queue-by-project map
  const queueByProject: Record<string, number> = {}
  for (const project of projects) {
    const len = getQueueLength(project.path)
    if (len > 0) {
      queueByProject[project.name] = len
    }
  }

  // Get locks held by this bot
  const locksHeld: string[] = []
  for (const projectPath of activeProjectPaths) {
    const holder = await getLockHolder(projectPath)
    // getLockHolder returns null if WE hold it (isOurLock), so active = we hold it
    if (holder === null) {
      locksHeld.push(projectPath)
    }
  }

  // Update elapsed times in runner infos
  const runners = getActiveRunnerInfos().map((r) => ({
    ...r,
    elapsedMs: getAnyElapsedMs(r.projectPath) || r.elapsedMs,
  }))

  const heartbeat: BotHeartbeat = {
    botId,
    pid: process.pid,
    updatedAt: Date.now(),
    queueLength: getQueueLength(),
    queueByProject,
    activeRunners: runners,
    locksHeld,
  }

  await mkdir(HEARTBEAT_DIR, { recursive: true })
  const filePath = join(HEARTBEAT_DIR, `${botId}.json`)
  await writeFile(filePath, JSON.stringify(heartbeat, null, 2), 'utf-8')
}

export function startHeartbeat(): void {
  if (timer) return
  const botId = deriveBotId()

  // Write immediately, then every 2s
  writeHeartbeat(botId).catch((err) => {
    console.error('[heartbeat] Initial write failed:', err)
  })
  timer = setInterval(() => {
    writeHeartbeat(botId).catch((err) => {
      console.error('[heartbeat] Write failed:', err)
    })
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
