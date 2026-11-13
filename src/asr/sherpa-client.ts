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

import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { isSecondaryBot, requestSharedAsr, type AsrResult } from './shared-asr.js'
import { createIdleTimer } from '../utils/idle-timer.js'

const TIMEOUT_MS = 60_000

/** Secondary bots borrow the main bot's recogniser instead of loading their own model. */
const SECONDARY = isSecondaryBot()
/** Extra time on top of TIMEOUT_MS for a shared request waiting behind another bot's. */
const SHARED_QUEUE_GRACE_MS = 60_000
/** How long a fallback recogniser on a secondary bot may sit idle before it is stopped. */
const FALLBACK_IDLE_MS = 5 * 60_000
/** Main bot: unload the model after this long without a voice message (0 = never). */
const MAIN_IDLE_MS = Math.round(env.ASR_IDLE_UNLOAD_MIN * 60_000)

/** Try running a command — returns true if it exits successfully. */
function canRun(cmd: string, args: readonly string[]): boolean {
  try {
    execFileSync(cmd, [...args], { stdio: 'pipe', timeout: 5_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Resolve python executable — works across all install methods and platforms. */
function resolvePython(): string {
  // 1. python in PATH (most common case)
  if (canRun('python', ['--version'])) return 'python'

  // 2. python3 (Linux/Mac where only python3 exists)
  if (canRun('python3', ['--version'])) return 'python3'

  if (process.platform !== 'win32') return 'python'

  // 3. Windows py launcher (installed by default, usually in PATH)
  if (canRun('py', ['-3', '--version'])) return 'py'

  // 4. Windows standard install: %LOCALAPPDATA%\Programs\Python\PythonXXX\
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData) {
    const pythonDir = join(localAppData, 'Programs', 'Python')
    if (existsSync(pythonDir)) {
      const versions = readdirSync(pythonDir)
        .filter((d: string) => d.startsWith('Python'))
        .sort()
        .reverse()
      for (const ver of versions) {
        const exe = join(pythonDir, ver, 'python.exe')
        if (existsSync(exe)) return exe
      }
    }
  }

  // 5. Microsoft Store: %LOCALAPPDATA%\Microsoft\WindowsApps\
  if (localAppData) {
    const storePython = join(localAppData, 'Microsoft', 'WindowsApps', 'python.exe')
    if (existsSync(storePython)) return storePython
  }

  // 6. Anaconda / Miniconda
  const home = process.env.USERPROFILE ?? ''
  if (home) {
    for (const dir of ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3']) {
      const exe = join(home, dir, 'python.exe')
      if (existsSync(exe)) return exe
    }
  }

  console.error('[sherpa] WARNING: python not found — voice recognition will fail')
  return 'python'
}

export const PYTHON_EXE = resolvePython()

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
      { cwd: join(process.cwd(), '..'), stdio: 'pipe', windowsHide: true },
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

  // --speed 1: no time compression.
  //
  // This used to pass --speed 2, which makes Sherpa_ASR decimate the waveform
  // with np.interp to half its length and then hand it to the recogniser still
  // labelled 16kHz — so speech plays back at 2x, pitch and formants shift an
  // octave, and with no low-pass before decimation everything above 4kHz
  // aliases back into the band. Paraformer was trained on normal speech. It
  // saved roughly half of a decode (~1-2s on a 20s note) and paid for it with
  // a systematically degraded transcript, which is why the Gemini pass existed
  // to "fix errors" afterwards.
  //
  // SpeakSlow — the newer, better-tuned pipeline — has no speed factor at all;
  // its only pre-decode step is volume normalisation. Note Sherpa_ASR's own
  // argparse default is 1.5, so 1 must be passed explicitly.
  console.error(`[sherpa] spawning: ${PYTHON_EXE} ${serverPath} --speed 1`)
  proc = spawn(PYTHON_EXE, [serverPath, '--speed', '1'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true,
  })

  // Handlers act only while this is still the current process. Without the
  // guard, the exit event of a process stopped on purpose (shutdownSherpa)
  // scheduled a restart, and could null out a newer process.
  const child = proc

  proc.on('error', (err) => {
    if (proc !== child) return
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
    if (proc !== child) return
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

/** Transcribe with this process's own recogniser (spawning it if needed). */
export async function transcribeLocal(wavPath: string): Promise<AsrResult> {
  idleUnload.touch()
  const res = await sendCommand({ action: 'transcribe', audio_path: wavPath })
  idleUnload.touch()
  return {
    success: res.success,
    text: res.text ?? '',
    duration: res.duration ?? 0,
    error: res.error,
  }
}

/** Releases the model once nobody has used it for a while; the next request loads it again. */
const idleUnload = createIdleTimer(
  SECONDARY ? FALLBACK_IDLE_MS : MAIN_IDLE_MS,
  () => {
    if (!proc) return
    console.error('[sherpa] idle — unloading the speech model (loads again on the next voice message)')
    shutdownSherpa()
  },
  () => pending !== null || commandQueue.length > 0,
)

/**
 * Transcribe a WAV file.
 *
 * The main bot uses its own recogniser. Secondary bots ask the main bot, so
 * the model is loaded once for all of them; only if the main bot cannot be
 * reached (it is restarting) do they start a temporary one of their own.
 */
export async function transcribeAudio(wavPath: string): Promise<AsrResult> {
  if (!SECONDARY) return transcribeLocal(wavPath)

  const shared = await requestSharedAsr(env.ASR_SHARE_PORT, wavPath, TIMEOUT_MS + SHARED_QUEUE_GRACE_MS)
  if (shared) return shared

  console.error('[sherpa] main bot recogniser unreachable — using a temporary local one')
  return transcribeLocal(wavPath)
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
  if (SECONDARY) {
    console.error('[sherpa] using the main bot recogniser — not loading a second model')
    return
  }
  if (MAIN_IDLE_MS > 0) {
    console.error(`[sherpa] speech model loads on the first voice message (unloads after ${env.ASR_IDLE_UNLOAD_MIN} idle min)`)
    return
  }
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
  idleUnload.cancel()
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
