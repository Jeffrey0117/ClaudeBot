import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

// Find all .env files: .env, .env.bot2, .env.bot3, ...
const envFiles = readdirSync(root)
  .filter((f) => f === '.env' || /^\.env\.bot\d+$/.test(f))
  .sort()

if (envFiles.length === 0) {
  console.error('No .env files found')
  process.exit(1)
}

// Single bot mode: --env flag passed directly
const singleEnv = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
const filesToLaunch = singleEnv ? [singleEnv] : envFiles

console.log(`Launching ${filesToLaunch.length} bot(s): ${filesToLaunch.join(', ')}`)

const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx')
const indexPath = path.join(root, 'src', 'index.ts')

const children = new Map<string, ChildProcess>()
let shuttingDown = false

const RESPAWN_DELAY_MS = 2000
const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES = 3

// Track recent crash timestamps per bot to detect crash loops
const crashHistory = new Map<string, number[]>()

function isCrashLooping(envFile: string): boolean {
  const now = Date.now()
  const history = crashHistory.get(envFile) ?? []
  const recent = [...history, now].filter((t) => now - t < CRASH_WINDOW_MS)
  crashHistory.set(envFile, recent)
  return recent.length >= MAX_CRASHES
}

function spawnBot(envFile: string): void {
  const label =
    envFile === '.env' ? 'main' : envFile.replace('.env.', '')

  const child = spawn(tsxBin, [indexPath, '--env', envFile], {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`[${label}] ${line}`)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.error(`[${label}] ${line}`)
    }
  })

  child.on('close', (code) => {
    console.log(`[${label}] exited (code ${code})`)
    children.delete(envFile)

    if (shuttingDown) {
      // Launcher is shutting down — don't respawn
      if (children.size === 0) {
        console.log('All bots stopped.')
        process.exit(0)
      }
      return
    }

    // Auto-respawn this bot only (with crash loop protection)
    if (isCrashLooping(envFile)) {
      console.error(`[${label}] crash loop detected (${MAX_CRASHES}x in ${CRASH_WINDOW_MS / 1000}s) — not respawning`)
      return
    }

    console.log(`[${label}] respawning in ${RESPAWN_DELAY_MS}ms...`)
    setTimeout(() => {
      if (!shuttingDown) {
        spawnBot(envFile)
      }
    }, RESPAWN_DELAY_MS)
  })

  children.set(envFile, child)
}

for (const envFile of filesToLaunch) {
  spawnBot(envFile)
}

// Dashboard server now runs in-process inside the main bot (see index.ts).
// No separate child process needed — this keeps the response broker EventEmitter
// in the same process as the queue-processor for zero-latency streaming.

// Graceful shutdown: forward signal to all children
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} — stopping all bots...`)
  for (const [, child] of children) {
    child.kill('SIGTERM')
  }
  // Force exit after 5s if children don't stop
  setTimeout(() => process.exit(0), 5000)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
