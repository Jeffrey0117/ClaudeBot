import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// --- P2: Admin notification via raw Telegram Bot API ---

function getNotifyConfig(): { botToken: string; chatId: string } | null {
  const chatId = process.env.ADMIN_CHAT_ID
  // Use main bot's token — launcher loads .env first via dotenv.config()
  const botToken = process.env.BOT_TOKEN
  if (!chatId || !botToken) return null
  return { botToken, chatId }
}

async function notifyAdmin(message: string): Promise<void> {
  const config = getNotifyConfig()
  if (!config) return
  try {
    await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(5_000),
      },
    )
  } catch {
    // Best-effort — don't crash launcher for notification failures
  }
}

function envFileToBotId(envFile: string): string {
  return envFile === '.env' ? 'main' : envFile.replace('.env.', '')
}

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
  // Disable standby & hibernate via powercfg for BOTH AC and DC (best-effort, non-fatal)
  try {
    execSync('powercfg /change standby-timeout-ac 0', { stdio: 'ignore' })
    execSync('powercfg /change standby-timeout-dc 0', { stdio: 'ignore' })
    execSync('powercfg /change hibernate-timeout-ac 0', { stdio: 'ignore' })
    execSync('powercfg /change hibernate-timeout-dc 0', { stdio: 'ignore' })
    console.log('[sleep-guard] powercfg: disabled AC+DC standby + hibernate timeouts')
  } catch {
    console.warn('[sleep-guard] powercfg failed (non-fatal) — continuing with API guard only')
  }

  // Disable Wi-Fi adapter power management so Windows won't turn off the NIC to save power
  try {
    execSync(
      'powershell -NoProfile -Command "Get-NetAdapter -Physical | Where-Object Status -eq \'Up\' | ForEach-Object { Set-NetAdapterPowerManagement -Name $_.Name -WakeOnMagicPacket Disabled -WakeOnPattern Disabled -DeviceSleepOnDisconnect Disabled -ErrorAction SilentlyContinue; powercfg /setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0; powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0; powercfg /setactive SCHEME_CURRENT }"',
      { stdio: 'ignore' },
    )
    console.log('[sleep-guard] Wi-Fi adapter power management: disabled')
  } catch {
    console.warn('[sleep-guard] Wi-Fi power management tweak failed (non-fatal)')
  }

  console.log(
    '[sleep-guard] TIP: 若蓋螢幕仍會休眠，請到「電源選項 → 蓋上螢幕時」設為「不做任何事」'
  )

  // PowerShell script that calls SetThreadExecutionState in a loop.
  // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
  // = 0x80000001 — prevents idle sleep (display can still turn off to save power)
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SleepGuard {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
Write-Host "[sleep-guard] Active — preventing system sleep (display may dim)"
while ($true) {
    [SleepGuard]::SetThreadExecutionState(0x80000001) | Out-Null
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

// Invoke node + tsx CLI directly (no .cmd wrapper) so process tree kill works on Windows.
// With shell:true, the tree is: launcher → cmd.exe → node.exe
// taskkill /T kills cmd.exe but orphans node.exe, creating zombie pollers.
// With shell:false + direct node invocation: launcher → node.exe (clean kill)
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const indexPath = path.join(root, 'src', 'index.ts')

const children = new Map<string, ChildProcess>()
let shuttingDown = false

const RESPAWN_DELAY_MS = 2000
const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES = 3
const RESTART_EXIT_CODE = 42  // Intentional restart (from /restart command)

// Track recent crash timestamps per bot to detect crash loops
const crashHistory = new Map<string, number[]>()

// Track which bots have successfully launched at least once (for respawn notifications)
const hasLaunchedOnce = new Set<string>()

// Track when each bot was spawned — watchdog skips bots still in startup grace period
const spawnTimestamps = new Map<string, number>()

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

  const child = spawn(process.execPath, [tsxCli, indexPath, '--env', envFile], {
    cwd: root,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.on('error', (err) => {
    console.error(`[${label}] spawn error:`, err.message)
    children.delete(envFile)
    notifyAdmin(`🚨 <b>[${label}]</b> spawn failed: ${err.message}`)
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
    const intentionalRestart = code === RESTART_EXIT_CODE
    console.log(`[${label}] exited (code ${code})${intentionalRestart ? ' [restart]' : ''}`)
    children.delete(envFile)

    if (shuttingDown) {
      // Launcher is shutting down — don't respawn
      if (children.size === 0) {
        console.log('All bots stopped.')
        process.exit(0)
      }
      return
    }

    // Intentional restart (/restart command) — skip crash loop counting
    if (intentionalRestart) {
      console.log(`[${label}] intentional restart — respawning in ${RESPAWN_DELAY_MS}ms...`)
      notifyAdmin(`🔄 <b>[${label}]</b> restarting...`)
      setTimeout(() => {
        if (!shuttingDown) spawnBot(envFile)
      }, RESPAWN_DELAY_MS)
      return
    }

    // Auto-respawn this bot only (with crash loop protection)
    if (isCrashLooping(envFile)) {
      console.error(`[${label}] crash loop detected (${MAX_CRASHES}x in ${CRASH_WINDOW_MS / 1000}s) — not respawning`)
      notifyAdmin(`🚨 <b>[${label}]</b> crash loop detected (${MAX_CRASHES}x in ${CRASH_WINDOW_MS / 1000}s) — <b>not respawning</b>. Manual intervention required.`)
      return
    }

    notifyAdmin(`⚠️ <b>[${label}]</b> crashed (code ${code}) — respawning in ${RESPAWN_DELAY_MS / 1000}s...`)

    console.log(`[${label}] respawning in ${RESPAWN_DELAY_MS}ms...`)
    setTimeout(() => {
      if (!shuttingDown) {
        spawnBot(envFile)
      }
    }, RESPAWN_DELAY_MS)
  })

  // Notify admin when bot starts (both first launch and respawn)
  const isRespawn = hasLaunchedOnce.has(envFile)
  hasLaunchedOnce.add(envFile)
  setTimeout(() => {
    // Verify child is still alive after 5s
    if (children.get(envFile) === child && !child.killed) {
      const icon = isRespawn ? '✅' : '🟢'
      const verb = isRespawn ? 'respawned' : 'started'
      notifyAdmin(`${icon} <b>[${label}]</b> ${verb} successfully (PID ${child.pid})`)
    }
  }, 5000)

  children.set(envFile, child)
  spawnTimestamps.set(envFile, Date.now())
}

for (const envFile of filesToLaunch) {
  spawnBot(envFile)
}

// --- P1: Watchdog — kill stale bots whose heartbeat stopped updating ---

const WATCHDOG_INTERVAL_MS = 10_000
const HEARTBEAT_STALE_MS = 30_000
const STARTUP_GRACE_MS = 60_000  // Don't check heartbeat until bot has had time to start
const heartbeatDir = path.join(root, 'data', 'heartbeat')

function startHealthCheck(): void {
  setInterval(() => {
    if (shuttingDown) return

    for (const [envFile, child] of children) {
      const botId = envFileToBotId(envFile)

      // Skip bots still in startup grace period (worktree sync, 409 retries, ASR init, etc.)
      const spawnedAt = spawnTimestamps.get(envFile) ?? 0
      if (Date.now() - spawnedAt < STARTUP_GRACE_MS) continue

      const hbPath = path.join(heartbeatDir, `${botId}.json`)

      try {
        const raw = readFileSync(hbPath, 'utf-8')
        const hb = JSON.parse(raw) as { updatedAt: number }

        // Skip if heartbeat predates this spawn (leftover from previous run)
        if (hb.updatedAt < spawnedAt) continue

        const staleMs = Date.now() - hb.updatedAt

        if (staleMs > HEARTBEAT_STALE_MS) {
          console.warn(`[watchdog] ${botId} heartbeat stale (${Math.round(staleMs / 1000)}s) — killing`)
          notifyAdmin(`🔍 <b>[${botId}]</b> heartbeat stale (${Math.round(staleMs / 1000)}s) — killing for respawn`)
          child.kill('SIGTERM')
        }
      } catch {
        // Heartbeat file doesn't exist yet (bot still starting) or read error — skip
      }
    }
  }, WATCHDOG_INTERVAL_MS)
}

startHealthCheck()

// --- Restart-all signal file watcher ---
// When a bot writes data/.restart-all, kill all bots so they respawn.

const RESTART_ALL_SIGNAL = path.join(root, 'data', '.restart-all')

function startRestartAllWatcher(): void {
  setInterval(() => {
    if (shuttingDown) return
    try {
      const content = readFileSync(RESTART_ALL_SIGNAL, 'utf-8').trim()
      if (!content) return
      // Delete signal file immediately to prevent re-triggering
      unlinkSync(RESTART_ALL_SIGNAL)
      console.log('[launcher] restart-all signal received — restarting all bots')
      notifyAdmin('🔄 <b>Restart ALL</b> — restarting all bot instances...')
      // Kill all running bots — close handlers will respawn them after RESPAWN_DELAY_MS
      for (const [, child] of children) {
        child.kill('SIGTERM')
      }
      // Clear crash history so all bots get a fresh start
      crashHistory.clear()
      // Deferred safety net: after close handlers + respawns have settled,
      // revive any bot still missing (crash-looped or failed to respawn).
      // 5s = enough for SIGTERM exit (~100ms) + RESPAWN_DELAY (2s) + startup (~2s)
      const REVIVE_DELAY_MS = 5000
      setTimeout(() => {
        if (shuttingDown) return
        for (const envFile of filesToLaunch) {
          if (!children.has(envFile)) {
            console.log(`[launcher] reviving bot not in children: ${envFile}`)
            spawnBot(envFile)
          }
        }
      }, REVIVE_DELAY_MS)
    } catch {
      // File doesn't exist or read error — normal, no signal pending
    }
  }, 2000)
}

startRestartAllWatcher()

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
