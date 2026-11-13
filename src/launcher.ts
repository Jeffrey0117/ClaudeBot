import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readdirSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import dotenv from 'dotenv'
import { createRotatingLog, teeProcessOutput } from './utils/rotating-log.js'
import { botIdFromEnvFile } from './config/bot-id.js'
import { isSleepCandidate, readBotEnv, sleepIdleMsFromEnv, startSleeper, type Sleeper } from './launcher-sleep.js'

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

// Same function the bot process uses for its own id (config/bot-id.ts), so the
// launcher always looks for the heartbeat file the bot actually writes.
const envFileToBotId = botIdFromEnvFile

const root = process.cwd()

// The launcher writes data/launcher.log itself so the file can be rotated
// (a file held open by a shell redirect cannot be moved aside on Windows).
// In a terminal the output still shows on screen; started hidden at boot it
// goes to the file only.
const LOG_MAX_BYTES = 5 * 1024 * 1024
const LOG_KEEP_FILES = 5
teeProcessOutput(
  createRotatingLog({ file: path.join(root, 'data', 'launcher.log'), maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP_FILES }),
  { passthrough: process.stdout.isTTY === true },
)

const PID_FILE = path.join(root, '.launcher.pid')
// Localhost-only port held for the launcher's lifetime. Binding it is atomic at
// the OS level, so it doubles as a race-free single-instance guard: two
// concurrent `npm run dev` invocations can't both acquire it.
const SINGLETON_PORT = 47615

// Synchronous sleep WITHOUT busy-spinning a CPU core: Atomics.wait blocks the
// thread for `ms` on a never-signalled lock (allowed on Node's main thread).
// (The old `while (Date.now() < end) {}` pegged a core for the full duration.)
const wait = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Kill previously-recorded launcher (restart semantics: the newest run wins).
try {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
  if (oldPid && oldPid !== process.pid && pidAlive(oldPid)) {
    if (process.platform === 'win32') {
      // taskkill /T kills the entire process tree (launcher + all child bots)
      try {
        execSync(`taskkill /F /T /PID ${oldPid}`, { stdio: 'ignore', windowsHide: true })
      } catch { /* already dead */ }
    } else {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* already dead */ }
    }
    console.log(`Killed previous launcher + children (PID ${oldPid})`)
    wait(1000)
  }
} catch {
  // No previous launcher or already dead — fine
}

// Single-instance guard. Without this, two launchers starting near-simultaneously
// (e.g. double `npm run dev`, or a stale PID file) each spawn a full set of bots.
// Duplicate instances share one Telegram token → 409 Conflict → crash → respawn → loop.
// Binding a localhost port is atomic, so exactly one launcher wins; the rest exit.
const singletonServer = net.createServer()
await new Promise<void>((resolve) => {
  let attempts = 0
  const tryListen = () => {
    singletonServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        attempts += 1
        if (attempts <= 10) {
          // A just-killed previous launcher may not have released the port yet.
          setTimeout(tryListen, 300)
          return
        }
        console.error('Another launcher instance is already running — exiting to avoid duplicate bots.')
        process.exit(0)
      }
      // Unexpected bind error — don't block startup over the guard.
      console.warn(`[launcher] singleton guard bind failed (${err.code}) — continuing without guard`)
      resolve()
    })
    singletonServer.listen(SINGLETON_PORT, '127.0.0.1', () => resolve())
  }
  tryListen()
})

// Write our PID
writeFileSync(PID_FILE, String(process.pid), 'utf-8')

// Load .env to check PREVENT_SLEEP
dotenv.config()

// Prevent Windows sleep when PREVENT_SLEEP=true
let sleepGuard: ChildProcess | null = null

if (process.env.PREVENT_SLEEP === 'true' && process.platform === 'win32') {
  // Disable standby & hibernate via powercfg for BOTH AC and DC (best-effort, non-fatal)
  try {
    execSync('powercfg /change standby-timeout-ac 0', { stdio: 'ignore', windowsHide: true })
    execSync('powercfg /change standby-timeout-dc 0', { stdio: 'ignore', windowsHide: true })
    execSync('powercfg /change hibernate-timeout-ac 0', { stdio: 'ignore', windowsHide: true })
    execSync('powercfg /change hibernate-timeout-dc 0', { stdio: 'ignore', windowsHide: true })
    console.log('[sleep-guard] powercfg: disabled AC+DC standby + hibernate timeouts')
  } catch {
    console.warn('[sleep-guard] powercfg failed (non-fatal) — continuing with API guard only')
  }

  // Disable Wi-Fi adapter power management so Windows won't turn off the NIC to save power
  try {
    execSync(
      'powershell -NoProfile -Command "Get-NetAdapter -Physical | Where-Object Status -eq \'Up\' | ForEach-Object { Set-NetAdapterPowerManagement -Name $_.Name -WakeOnMagicPacket Disabled -WakeOnPattern Disabled -DeviceSleepOnDisconnect Disabled -ErrorAction SilentlyContinue; powercfg /setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0; powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0; powercfg /setactive SCHEME_CURRENT }"',
      { stdio: 'ignore', windowsHide: true },
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
      windowsHide: true,
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

// Run each bot as ONE node process with tsx loaded in-process (`--import tsx`).
// Going through the tsx CLI added a second ~55 MB wrapper process per bot;
// going through a shell orphaned node.exe on tree kill (zombie pollers).
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

interface SpawnOptions {
  /** Woken from sleep: let the bot receive the update that woke it, and skip the admin ping. */
  readonly woken?: boolean
}

function labelOf(envFile: string): string {
  return envFile === '.env' ? 'main' : envFile.replace('.env.', '')
}

function spawnBot(envFile: string, opts: SpawnOptions = {}): void {
  const label = labelOf(envFile)

  const child = spawn(process.execPath, ['--import', 'tsx', indexPath, '--env', envFile], {
    cwd: root,
    env: opts.woken ? { ...process.env, CLAUDEBOT_KEEP_PENDING: '1' } : process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.on('error', (err) => {
    console.error(`[${label}] 啟動錯誤:`, err.message)
    children.delete(envFile)
    notifyAdmin(`🚨 <b>[${label}]</b> 啟動失敗: ${err.message}`)
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
    // exit code null = 被 SIGTERM/SIGKILL 終止（看門狗、/restart-all、外部關閉）。
    // 這是「重啟」不是「崩潰」，不該嚇人、也不該計入崩潰迴圈。
    const wasKilled = code === null
    const tag = intentionalRestart ? ' [重啟]' : wasKilled ? ' [被終止]' : ''
    console.log(`[${label}] 結束 (code ${code})${tag}`)
    children.delete(envFile)

    // Stopped on purpose because it was idle — listen on its behalf instead of respawning
    if (sleepRequested.delete(envFile) && !shuttingDown) {
      setTimeout(() => {
        if (!shuttingDown) putToSleep(envFile)
      }, RESPAWN_DELAY_MS)
      return
    }

    if (shuttingDown) {
      // 啟動器正在關閉 — 不重啟
      if (children.size === 0) {
        console.log('所有 bot 已停止。')
        process.exit(0)
      }
      return
    }

    // 正常重啟（/restart 指令，或被外部/看門狗終止）— 不計入崩潰次數
    if (intentionalRestart || wasKilled) {
      const why = intentionalRestart ? '正常重啟' : '被終止'
      console.log(`[${label}] ${why} — ${RESPAWN_DELAY_MS}ms 後重新啟動...`)
      notifyAdmin(`🔄 <b>[${label}]</b> ${why}，重新啟動中...`)
      setTimeout(() => {
        if (!shuttingDown) spawnBot(envFile)
      }, RESPAWN_DELAY_MS)
      return
    }

    // 真正的異常結束（有數字 exit code）— 套用崩潰迴圈保護
    if (isCrashLooping(envFile)) {
      console.error(`[${label}] 偵測到崩潰迴圈（${CRASH_WINDOW_MS / 1000} 秒內 ${MAX_CRASHES} 次）— 停止重啟`)
      notifyAdmin(`🚨 <b>[${label}]</b> 崩潰迴圈（${CRASH_WINDOW_MS / 1000} 秒內 ${MAX_CRASHES} 次）— <b>已停止重啟</b>，需人工處理。`)
      return
    }

    notifyAdmin(`⚠️ <b>[${label}]</b> 異常結束 (code ${code}) — ${RESPAWN_DELAY_MS / 1000} 秒後重啟...`)

    console.log(`[${label}] ${RESPAWN_DELAY_MS}ms 後重啟...`)
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
    if (children.get(envFile) === child && !child.killed && !opts.woken) {
      const icon = isRespawn ? '✅' : '🟢'
      const verb = isRespawn ? '重新啟動成功' : '啟動成功'
      notifyAdmin(`${icon} <b>[${label}]</b> ${verb} (PID ${child.pid})`)
    }
  }, 5000)

  children.set(envFile, child)
  spawnTimestamps.set(envFile, Date.now())
}

// --- Sleeping bots ---
// With BOT_SLEEP_AFTER_MIN set, secondary bots do not run while nobody talks to
// them: the launcher holds one long poll per sleeping bot and starts the real
// process on the first update. The main bot (.env) never sleeps — it hosts the
// relay, dashboard, schedulers and the shared speech recogniser.

const SLEEP_IDLE_MS = singleEnv ? 0 : sleepIdleMsFromEnv(process.env.BOT_SLEEP_AFTER_MIN)
const SLEEP_CHECK_INTERVAL_MS = 30_000
const SLEEP_POLL_SECONDS = 25
const SLEEP_RETRY_DELAY_MS = 5_000
const SLEEP_MAX_FAILURES = 6
const sleepers = new Map<string, Sleeper>() // envFile → listener for a sleeping bot
const sleepRequested = new Set<string>() // envFiles being stopped in order to sleep
const sleepHeartbeatDir = path.join(root, 'data', 'heartbeat')

function canSleep(envFile: string): boolean {
  return SLEEP_IDLE_MS > 0 && envFile !== '.env'
}

/** Keep the dashboard showing a sleeping bot as reachable (it is — it wakes on a message). */
function writeSleepingHeartbeat(envFile: string): void {
  try {
    mkdirSync(sleepHeartbeatDir, { recursive: true })
    const botId = envFileToBotId(envFile)
    writeFileSync(
      path.join(sleepHeartbeatDir, `${botId}.json`),
      JSON.stringify(
        { botId, pid: 0, updatedAt: Date.now(), queueLength: 0, queueByProject: {}, activeRunners: [], locksHeld: [], machines: [], sleeping: true },
        null,
        2,
      ),
      'utf-8',
    )
  } catch {
    // cosmetic only
  }
}

/** Tell the person who just wrote that something is happening while the bot starts. */
function showTyping(apiBase: string, token: string, update: unknown): void {
  const u = update as { message?: { chat?: { id?: number } }; callback_query?: { message?: { chat?: { id?: number } } } }
  const chatId = u?.message?.chat?.id ?? u?.callback_query?.message?.chat?.id
  if (typeof chatId !== 'number') return
  fetch(`${apiBase}/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

function putToSleep(envFile: string): void {
  if (sleepers.has(envFile) || children.has(envFile)) return
  const label = labelOf(envFile)
  const botEnv = readBotEnv(path.join(root, envFile))
  if (!botEnv) {
    console.warn(`[${label}] 讀不到 token，無法代聽 — 直接啟動`)
    spawnBot(envFile)
    return
  }

  const wake = (why: string, update?: unknown): void => {
    sleepers.delete(envFile)
    if (shuttingDown) return
    console.log(`[${label}] 喚醒（${why}）`)
    if (update !== undefined) showTyping(botEnv.apiBase, botEnv.token, update)
    spawnBot(envFile, { woken: true })
  }

  console.log(`[${label}] 睡眠中 — 有訊息才啟動`)
  writeSleepingHeartbeat(envFile)
  sleepers.set(
    envFile,
    startSleeper({
      ...botEnv,
      pollSeconds: SLEEP_POLL_SECONDS,
      retryDelayMs: SLEEP_RETRY_DELAY_MS,
      maxFailures: SLEEP_MAX_FAILURES,
      onWake: (update) => wake('收到訊息', update),
      // Fail open: if listening does not work, run the bot the old way.
      onGiveUp: (reason) => wake(`代聽失敗: ${reason}`),
    }),
  )
}

function startSleepManager(): void {
  if (SLEEP_IDLE_MS <= 0) return
  console.log(`[launcher] 副 bot 閒置 ${Math.round(SLEEP_IDLE_MS / 60_000)} 分鐘後睡眠，有訊息自動喚醒`)

  setInterval(() => {
    if (shuttingDown) return

    for (const envFile of sleepers.keys()) writeSleepingHeartbeat(envFile)

    for (const [envFile, child] of children) {
      if (!canSleep(envFile) || sleepRequested.has(envFile) || gracefulPending.has(envFile)) continue
      if (Date.now() - (spawnTimestamps.get(envFile) ?? 0) < STARTUP_GRACE_MS) continue
      try {
        const hb: unknown = JSON.parse(
          readFileSync(path.join(sleepHeartbeatDir, `${envFileToBotId(envFile)}.json`), 'utf-8'),
        )
        if (!isSleepCandidate(hb, Date.now(), SLEEP_IDLE_MS)) continue
      } catch {
        continue
      }
      console.log(`[${labelOf(envFile)}] 閒置 ${Math.round(SLEEP_IDLE_MS / 60_000)} 分鐘 — 進入睡眠`)
      sleepRequested.add(envFile)
      child.kill('SIGTERM')
    }
  }, SLEEP_CHECK_INTERVAL_MS)
}

for (const envFile of filesToLaunch) {
  // Secondary bots start asleep; anything already waiting for them wakes them at once.
  if (canSleep(envFile)) putToSleep(envFile)
  else spawnBot(envFile)
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
          console.warn(`[看門狗] ${botId} heartbeat 卡住 ${Math.round(staleMs / 1000)} 秒 — 終止重啟`)
          notifyAdmin(`🔍 <b>[${botId}]</b> heartbeat 卡住 ${Math.round(staleMs / 1000)} 秒（可能忙到沒回報）— 終止後重新啟動`)
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

      // Auto-build before restart — ensures dist/ matches src/ changes.
      // Without this, bots may run stale compiled code even though tsx reads src/.
      console.log('[launcher] restart-all signal received — building before restart...')
      try {
        execSync('npx tsc', { cwd: root, timeout: 30_000, stdio: 'pipe', windowsHide: true })
        console.log('[launcher] build complete')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[launcher] build failed (continuing anyway): ${msg}`)
      }

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
          // A sleeping bot is not missing — it picks up new code when it wakes.
          if (!children.has(envFile) && !sleepers.has(envFile)) {
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

// --- Graceful restart-all: restart each bot only once it's idle ---
// Triggered by data/.restart-graceful (from /restart all and /deploy). Busy
// bots keep serving and restart the moment they drain — no interruption.

const RESTART_GRACEFUL_SIGNAL = path.join(root, 'data', '.restart-graceful')
const gracefulPending = new Set<string>()        // envFiles awaiting idle
const gracefulDeadline = new Map<string, number>() // envFile → force-restart-by ts
const GRACEFUL_MAX_WAIT_MS = 10 * 60_000           // don't wait forever for a stuck bot

function isBotIdle(botId: string): boolean {
  try {
    const hb = JSON.parse(
      readFileSync(path.join(heartbeatDir, `${botId}.json`), 'utf-8'),
    ) as { updatedAt: number; queueLength: number; activeRunners: unknown[] }
    // Stale heartbeat → can't confirm idle, keep waiting (deadline covers stuck bots)
    if (Date.now() - hb.updatedAt > 15_000) return false
    return hb.queueLength === 0 && (hb.activeRunners?.length ?? 0) === 0
  } catch {
    return false
  }
}

function startGracefulRestartWatcher(): void {
  setInterval(() => {
    if (shuttingDown) return

    // 1. Pick up a new graceful-restart signal
    try {
      const content = readFileSync(RESTART_GRACEFUL_SIGNAL, 'utf-8').trim()
      if (content) {
        unlinkSync(RESTART_GRACEFUL_SIGNAL)
        console.log('[launcher] 優雅重啟信號 — 編譯後等各 bot 閒置再重啟...')
        try {
          execSync('npx tsc', { cwd: root, timeout: 30_000, stdio: 'pipe', windowsHide: true })
          console.log('[launcher] 編譯完成')
        } catch (err) {
          console.error(`[launcher] 編譯失敗（仍繼續）: ${err instanceof Error ? err.message : String(err)}`)
        }
        notifyAdmin('🔄 <b>優雅重啟</b> — 各 bot 跑完手上任務後自動重啟（不中斷）')
        const now = Date.now()
        for (const envFile of children.keys()) {
          gracefulPending.add(envFile)
          gracefulDeadline.set(envFile, now + GRACEFUL_MAX_WAIT_MS)
        }
      }
    } catch {
      // no signal pending
    }

    // 2. Restart any pending bot that has gone idle (or hit the fallback deadline)
    for (const envFile of [...gracefulPending]) {
      const child = children.get(envFile)
      if (!child) {
        gracefulPending.delete(envFile)
        gracefulDeadline.delete(envFile)
        continue
      }
      const botId = envFileToBotId(envFile)
      const timedOut = Date.now() > (gracefulDeadline.get(envFile) ?? 0)
      if (isBotIdle(botId) || timedOut) {
        console.log(`[launcher] 優雅重啟 ${botId}${timedOut ? '（逾時強制）' : '（已閒置）'}`)
        notifyAdmin(`🔄 <b>[${botId}]</b> ${timedOut ? '逾時強制重啟' : '已閒置，重啟中'}`)
        gracefulPending.delete(envFile)
        gracefulDeadline.delete(envFile)
        child.kill('SIGTERM') // close handler respawns with new code (歸類為「被終止」非崩潰)
      }
    }
  }, 3000)
}

startGracefulRestartWatcher()
startSleepManager()

// Graceful shutdown: forward signal to all children, clean up PID file
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} — stopping all bots...`)

  // Clean up PID file + release the single-instance port so a restart can rebind.
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }
  try { singletonServer.close() } catch { /* ignore */ }

  // Stop sleep guard
  if (sleepGuard) {
    sleepGuard.kill('SIGTERM')
    sleepGuard = null
  }

  for (const sleeper of sleepers.values()) sleeper.stop()
  sleepers.clear()

  for (const [, child] of children) {
    child.kill('SIGTERM')
  }
  // Force exit after 5s if children don't stop
  setTimeout(() => process.exit(0), 5000)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
