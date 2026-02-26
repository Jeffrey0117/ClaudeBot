/**
 * Sherpa-ONNX ASR IPC client.
 * Lazily spawns the Python server on first use,
 * communicates via stdin/stdout JSON lines.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { env } from '../config/env.js'

const TIMEOUT_MS = 60_000

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

function ensureProcess(): void {
  if (proc) return

  const serverPath = env.SHERPA_SERVER_PATH
  if (!serverPath) {
    throw new Error('SHERPA_SERVER_PATH is not configured')
  }

  proc = spawn('python', [serverPath], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })

  rl = createInterface({ input: proc.stdout! })

  // First line is the init result — consume it
  let initConsumed = false
  rl.on('line', (line: string) => {
    if (!initConsumed) {
      initConsumed = true
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
  })

  proc.on('exit', () => {
    proc = null
    rl = null
    if (pending) {
      const { reject, timer } = pending
      pending = null
      clearTimeout(timer)
      reject(new Error('Sherpa process exited unexpectedly'))
    }
  })
}

function sendCommand(cmd: Record<string, unknown>): Promise<SherpaResponse> {
  ensureProcess()

  if (pending) {
    return Promise.reject(new Error('Sherpa: previous request still pending'))
  }

  return new Promise<SherpaResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending) {
        pending = null
        reject(new Error('Sherpa: request timed out'))
      }
    }, TIMEOUT_MS)

    pending = { resolve, reject, timer }
    proc!.stdin!.write(JSON.stringify(cmd) + '\n')
  })
}

export async function transcribeAudio(
  wavPath: string,
): Promise<{ readonly success: boolean; readonly text: string; readonly duration: number }> {
  const res = await sendCommand({ action: 'transcribe', audio_path: wavPath })
  return {
    success: res.success,
    text: res.text ?? '',
    duration: res.duration ?? 0,
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

export function warmupSherpa(): void {
  try {
    ensureProcess()
  } catch {
    // ignore — will retry on first voice message
  }
}

export function shutdownSherpa(): void {
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
