import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const root = process.cwd()
const PID_FILE = path.join(root, '.launcher.pid')

// Kill previous launcher if PID file exists
try {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
  if (oldPid && oldPid !== process.pid) {
    if (process.platform === 'win32') {
      // taskkill /T kills the entire process tree (launcher + all child bots)
      try {
        execSync(`taskkill /F /T /PID ${oldPid}`, { stdio: 'ignore' })
      } catch { /* already dead */ }
    } else {
      process.kill(oldPid, 'SIGTERM')
    }
    console.log(`Killed previous launcher + children (PID ${oldPid})`)
    const wait = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) {} }
    wait(1000)
  }
} catch {
  // No previous launcher or already dead — fine
}

// Write our PID
writeFileSync(PID_FILE, String(process.pid), 'utf-8')

// Load .env to check PREVENT_SLEEP
dotenv.config()

// Prevent Windows sleep when PREVENT_SLEEP=true
let sleepGuard: ChildProcess | null = null

if (process.env.PREVENT_SLEEP === 'true' && process.platform === 'win32') {
  // Disable AC standby & hibernate via powercfg (best-effort, non-fatal)
  try {
    execSync('powercfg /change standby-timeout-ac 0', { stdio: 'ignore' })
    execSync('powercfg /change hibernate-timeout-ac 0', { stdio: 'ignore' })
    console.log('[sleep-guard] powercfg: disabled AC standby + hibernate timeouts')
  } catch {
    console.warn('[sleep-guard] powercfg failed (non-fatal) — continuing with API guard only')
  }

  console.log(
    '[sleep-guard] TIP: 若蓋螢幕仍會休眠，請到「電源選項 → 蓋上螢幕時」設為「不做任何事」'
  )

  // PowerShell script that calls SetThreadExecutionState in a loop.
  // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) | ES_DISPLAY_REQUIRED (0x00000002)
  // = 0x80000003 — prevents idle sleep AND display off
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SleepGuard {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
Write-Host "[sleep-guard] Active — preventing system sleep + display off"
while ($true) {
    [SleepGuard]::SetThreadExecutionState(0x80000003) | Out-Null
    Start-Sleep -Seconds 30
}
`

  function spawnSleepGuard(): void {
    sleepGuard = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    sleepGuard.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.log(line.trim())
      }
    })

    sleepGuard.on('close', (code) => {
      sleepGuard = null
      if (!shuttingDown) {
        console.warn(`[sleep-guard] process exited unexpectedly (code ${code}), restarting...`)
        setTimeout(spawnSleepGuard, 2000)
      }
    })
  }

  spawnSleepGuard()
}

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

console.log(`Launcher PID ${process.pid} — ${filesToLaunch.length} bot(s): ${filesToLaunch.join(', ')}`)

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

// Graceful shutdown: forward signal to all children, clean up PID file
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} — stopping all bots...`)

  // Clean up PID file
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }

  // Stop sleep guard
  if (sleepGuard) {
    sleepGuard.kill('SIGTERM')
    sleepGuard = null
  }

  for (const [, child] of children) {
    child.kill('SIGTERM')
  }
  // Force exit after 5s if children don't stop
  setTimeout(() => process.exit(0), 5000)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
