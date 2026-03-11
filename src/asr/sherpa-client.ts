/**
 * Sherpa-ONNX ASR IPC client.
 * Lazily spawns the Python server on first use,
 * communicates via stdin/stdout JSON lines.
 *
 * Auto-resolves server path:
 *   1. SHERPA_SERVER_PATH env var (explicit override)
 *   2. ../Sherpa_ASR/sherpa_server.py (sibling repo)
 *   3. Attempts to clone Jeffrey0117/Sherpa_ASR
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { env } from '../config/env.js'

const TIMEOUT_MS = 60_000

/* ── Auto-restart crash loop protection ── */
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 60_000
const RESTART_DELAY_MS = 2_000
const crashTimestamps: number[] = []
let restartTimer: ReturnType<typeof setTimeout> | null = null
let gavUp = false

function isCrashLooping(): boolean {
  const now = Date.now()
  // keep only recent crashes within window
  while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_WINDOW_MS) {
    crashTimestamps.shift()
  }
  return crashTimestamps.length >= MAX_CRASHES
}

function scheduleRestart(reason: string): void {
  if (restartTimer || gavUp) return
  crashTimestamps.push(Date.now())
  if (isCrashLooping()) {
    gavUp = true
    console.error(`[sherpa] crash loop detected (${MAX_CRASHES}x in ${CRASH_WINDOW_MS / 1000}s) — giving up auto-restart`)
    return
  }
  console.error(`[sherpa] ${reason}, restarting in ${RESTART_DELAY_MS / 1000}s...`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    try {
      ensureProcess()
      console.error('[sherpa] auto-restart successful')
    } catch (err) {
      console.error('[sherpa] auto-restart failed:', err instanceof Error ? err.message : err)
    }
  }, RESTART_DELAY_MS)
}

interface SherpaResponse {
  readonly success: boolean
  readonly text?: string
  readonly duration?: number
  readonly error?: string
}

let proc: ChildProcess | null = null
let rl: Interface | null = null
let pending: {
  readonly resolve: (value: SherpaResponse) => void
  readonly reject: (reason: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
} | null = null

/** Queue of commands waiting to be sent (FIFO). */
const commandQueue: Array<{
  readonly cmd: Record<string, unknown>
  readonly resolve: (value: SherpaResponse) => void
  readonly reject: (reason: Error) => void
}> = []

/** Resolve sherpa_server.py location, auto-clone if needed. */
function resolveServerPath(): string {
  // 1. Explicit env override
  if (env.SHERPA_SERVER_PATH) return env.SHERPA_SERVER_PATH

  // 2. Sibling repo (../Sherpa_ASR/)
  const siblingPath = join(process.cwd(), '..', 'Sherpa_ASR', 'sherpa_server.py')
  if (existsSync(siblingPath)) return siblingPath

  // 3. Auto-clone
  const cloneDir = join(process.cwd(), '..', 'Sherpa_ASR')
  try {
    execSync(
      'git clone https://github.com/Jeffrey0117/Sherpa_ASR.git',
      { cwd: join(process.cwd(), '..'), stdio: 'pipe' },
    )
    const clonedPath = join(cloneDir, 'sherpa_server.py')
    if (existsSync(clonedPath)) return clonedPath
  } catch {
    // clone failed — no git or no network
  }

  throw new Error(
    'Sherpa ASR not found. Clone it next to ClaudeBot:\n' +
    '  git clone https://github.com/Jeffrey0117/Sherpa_ASR.git',
  )
}

function ensureProcess(): void {
  if (proc) return

  const serverPath = resolveServerPath()

  // --speed 2: fast processing, np.interp resampling + Gemini LLM fixes errors
  proc = spawn('python', [serverPath, '--speed', '2'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })

  proc.on('error', (err) => {
    console.error('[sherpa] spawn error:', err.message)
    proc = null
    rl = null
    if (pending) {
      const { reject, timer } = pending
      pending = null
      clearTimeout(timer)
      reject(new Error(`Sherpa 啟動失敗: ${err.message}`))
    }
    for (const queued of commandQueue.splice(0)) {
      queued.reject(new Error(`Sherpa 啟動失敗: ${err.message}`))
    }
    scheduleRestart(`spawn error: ${err.message}`)
  })

  rl = createInterface({ input: proc.stdout! })

  // Log stderr for debugging
  if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[sherpa-stderr]', chunk.toString().trim())
    })
  }

  // First line is the init result — consume it
  let initConsumed = false
  rl.on('line', (line: string) => {
    if (!initConsumed) {
      initConsumed = true
      console.log('[sherpa-init]', line)
      return
    }
    if (!pending) return
    const { resolve, timer } = pending
    pending = null
    clearTimeout(timer)
    try {
      resolve(JSON.parse(line) as SherpaResponse)
    } catch {
      resolve({ success: false, error: 'Invalid JSON from Sherpa' })
    }
    drainQueue()
  })

  proc.on('exit', (code) => {
    proc = null
    rl = null
    if (pending) {
      const { reject, timer } = pending
      pending = null
      clearTimeout(timer)
      reject(new Error('Sherpa process exited unexpectedly'))
    }
    for (const queued of commandQueue.splice(0)) {
      queued.reject(new Error('Sherpa process exited unexpectedly'))
    }
    scheduleRestart(`process exited with code ${code ?? 'unknown'}`)
  })
}

/** Flush the next queued command if the channel is free. */
function drainQueue(): void {
  if (pending || commandQueue.length === 0) return
  const next = commandQueue.shift()!
  executeCommand(next.cmd, next.resolve, next.reject)
}

function executeCommand(
  cmd: Record<string, unknown>,
  resolve: (value: SherpaResponse) => void,
  reject: (reason: Error) => void,
): void {
  const timer = setTimeout(() => {
    if (pending) {
      pending = null
      reject(new Error('Sherpa: request timed out'))
      drainQueue()
    }
  }, TIMEOUT_MS)

  pending = { resolve, reject, timer }
  proc!.stdin!.write(JSON.stringify(cmd) + '\n')
}

function sendCommand(cmd: Record<string, unknown>): Promise<SherpaResponse> {
  ensureProcess()

  if (pending) {
    // Queue instead of rejecting — will run when current request finishes
    return new Promise<SherpaResponse>((resolve, reject) => {
      commandQueue.push({ cmd, resolve, reject })
    })
  }

  return new Promise<SherpaResponse>((resolve, reject) => {
    executeCommand(cmd, resolve, reject)
  })
}

export async function transcribeAudio(
  wavPath: string,
): Promise<{ readonly success: boolean; readonly text: string; readonly duration: number; readonly error?: string }> {
  const res = await sendCommand({ action: 'transcribe', audio_path: wavPath })
  return {
    success: res.success,
    text: res.text ?? '',
    duration: res.duration ?? 0,
    error: res.error,
  }
}

/**
 * Push additional hotwords to the running Sherpa server.
 * Words should be space-separated characters for Chinese,
 * or plain English words (e.g. "ClaudeBot", "WeeTube").
 */
export async function addHotwords(words: readonly string[]): Promise<void> {
  if (words.length === 0) return
  try {
    ensureProcess()
    await sendCommand({
      action: 'set_hotwords',
      config: { words: [...words] },
    })
    console.log(`[sherpa] Injected ${words.length} hotwords:`, words.slice(0, 10).join(', '))
  } catch (err) {
    console.warn('[sherpa] Failed to set hotwords:', err)
  }
}

/** Check if Sherpa ASR is available (env var set or sibling repo exists). */
export function isSherpaAvailable(): boolean {
  try {
    resolveServerPath()
    return true
  } catch {
    return false
  }
}

export function warmupSherpa(): void {
  try {
    ensureProcess()
    console.error('[sherpa] warmup OK — process spawned')
  } catch (err) {
    console.error('[sherpa] warmup FAILED:', err instanceof Error ? err.message : err)
  }
}

export function getSherpaStatus(): {
  readonly running: boolean
  readonly crashed: boolean
  readonly recentCrashes: number
} {
  return {
    running: proc !== null,
    crashed: gavUp,
    recentCrashes: crashTimestamps.length,
  }
}

export function shutdownSherpa(): void {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!proc) return
  try {
    proc.stdin!.write(JSON.stringify({ action: 'exit' }) + '\n')
  } catch {
    // ignore write errors during shutdown
  }
  proc.kill()
  proc = null
  rl = null
}

/** Reset crash loop state — allows auto-restart after manual intervention. */
export function resetSherpa(): void {
  shutdownSherpa()
  crashTimestamps.length = 0
  gavUp = false
}
