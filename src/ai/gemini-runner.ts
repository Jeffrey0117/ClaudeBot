import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { AIRunner, AIRunOptions, AIBackend } from './types.js'
import { setAISessionId } from './session-store.js'
import { validateProjectPath } from '../utils/path-validator.js'

const MAX_ACCUMULATED_LENGTH = 100_000

/** Gemini model aliases → actual model IDs */
const MODEL_MAP: Record<string, string> = {
  'flash-lite': 'gemini-2.5-flash-lite',
  'flash': 'gemini-2.5-flash',
  'pro': 'gemini-2.5-pro',
}

function resolveModel(alias: string): string {
  return MODEL_MAP[alias] ?? alias
}

function resolveGeminiCli(): { cmd: string; prefix: readonly string[]; shell: boolean } {
  if (process.platform !== 'win32') {
    return { cmd: 'gemini', prefix: [], shell: false }
  }
  try {
    const cmdPath = execSync('where gemini.cmd', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim()
    const dir = path.dirname(cmdPath)
    const content = readFileSync(cmdPath, 'utf-8')
    // Extract JS entry point from npm .cmd shim (e.g. "%~dp0\node_modules\pkg\cli.js")
    const matches = [...content.matchAll(/(?:%~dp0|%dp0%)\\([^\s"]+\.js)/gi)]
    if (matches.length > 0) {
      const relPath = matches[matches.length - 1][1]
      const cliJs = path.join(dir, relPath)
      if (existsSync(cliJs)) {
        return { cmd: process.execPath, prefix: [cliJs], shell: false }
      }
    }
  } catch { /* fallback below */ }
  return { cmd: 'gemini', prefix: [], shell: true }
}

const geminiCli = resolveGeminiCli()

interface ActiveProcess {
  readonly proc: ChildProcess
  readonly startedAt: number
  cancelled: boolean
}

const activeProcesses = new Map<string, ActiveProcess>()

/**
 * Gemini CLI JSONL event types.
 * Based on @google/gemini-cli-core/src/output/types.ts
 */
interface GeminiInitEvent {
  readonly type: 'init'
  readonly session_id?: string
  readonly model?: string
}

interface GeminiMessageEvent {
  readonly type: 'message'
  readonly role: 'user' | 'assistant'
  readonly content: string
  /** true = incremental delta, false/absent = full content */
  readonly delta?: boolean
}

interface GeminiToolUseEvent {
  readonly type: 'tool_use'
  readonly tool_name?: string
  readonly tool_id?: string
}

interface GeminiToolResultEvent {
  readonly type: 'tool_result'
  readonly tool_id?: string
  readonly status?: 'success' | 'error'
  readonly output?: string
}

interface GeminiErrorEvent {
  readonly type: 'error'
  readonly severity?: 'warning' | 'error'
  readonly message?: string
}

interface GeminiResultEvent {
  readonly type: 'result'
  readonly status?: 'success' | 'error'
  readonly error?: { type: string; message: string }
  readonly stats?: {
    readonly total_tokens?: number
    readonly duration_ms?: number
  }
}

type GeminiStreamEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiErrorEvent
  | GeminiResultEvent

export const geminiRunner: AIRunner = {
  backend: 'gemini' as AIBackend,

  run(options: AIRunOptions): void {
    const { prompt, projectPath, model, sessionId, onTextDelta, onToolUse, onResult, onError } = options

    let validatedPath: string
    try {
      validatedPath = validateProjectPath(projectPath)
    } catch (error) {
      onError(`Invalid project path: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const resolvedModel = resolveModel(model)

    // Gemini CLI has no --system-prompt flag, so prepend language hint on first turn
    const effectivePrompt = sessionId
      ? prompt
      : `[請用繁體中文回覆，除非用戶寫英文]\n\n${prompt}`

    const args = [
      '--prompt', effectivePrompt,
      '--output-format', 'stream-json',
      '--model', resolvedModel,
      '--sandbox', 'false',
    ]

    if (sessionId) {
      args.push('--resume', sessionId)
    }

    console.log('[gemini-runner] spawning gemini, cwd:', validatedPath)
    console.log('[gemini-runner] model:', resolvedModel, 'prompt:', prompt.slice(0, 50))

    const proc = spawn(geminiCli.cmd, [...geminiCli.prefix, ...args], {
      cwd: validatedPath,
      shell: geminiCli.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    console.log('[gemini-runner] process spawned, pid:', proc.pid)

    const active: ActiveProcess = { proc, startedAt: Date.now(), cancelled: false }
    activeProcesses.set(validatedPath, active)
    let accumulated = ''
    let buffer = ''
    let stderrBuf = ''
    let resultReceived = false
    let capturedSessionId = sessionId ?? ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const event = JSON.parse(trimmed) as GeminiStreamEvent
          handleGeminiEvent(event, {
            onInit: (sid) => {
              if (sid) capturedSessionId = sid
            },
            onTextDelta: (text) => {
              accumulated += text
              if (accumulated.length > MAX_ACCUMULATED_LENGTH) {
                accumulated = accumulated.slice(-MAX_ACCUMULATED_LENGTH)
              }
              onTextDelta(text, accumulated)
            },
            onToolUse,
            onResult: (result) => {
              resultReceived = true
              const sid = result.sessionId || capturedSessionId
              if (sid) {
                try {
                  setAISessionId('gemini', validatedPath, sid)
                } catch (err) {
                  console.error('[gemini-runner] Failed to save session ID:', err)
                }
              }

              // If result and accumulated are both empty, surface stderr as diagnostics
              const text = result.resultText || accumulated
              if (!text.trim() && stderrBuf.trim()) {
                onError(`Gemini 無回覆。stderr:\n${stderrBuf.trim().slice(0, 500)}`)
                return
              }

              onResult({
                backend: 'gemini',
                model,
                sessionId: sid,
                costUsd: result.costUsd,
                durationMs: result.durationMs,
                cancelled: false,
                resultText: result.resultText || accumulated,
              })
            },
            onError,
          })
        } catch {
          // skip non-JSON lines
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) stderrBuf += text + '\n'
      console.log('[gemini-runner] stderr:', text)
    })

    proc.on('close', (code) => {
      console.log('[gemini-runner] process closed, code:', code, 'project:', validatedPath)
      activeProcesses.delete(validatedPath)

      if (active.cancelled || resultReceived) return

      // Try to parse remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as GeminiStreamEvent
          handleGeminiEvent(event, {
            onInit: (sid) => { if (sid) capturedSessionId = sid },
            onTextDelta: (text) => {
              accumulated += text
              onTextDelta(text, accumulated)
            },
            onToolUse,
            onResult: (result) => {
              resultReceived = true
              const sid = result.sessionId || capturedSessionId
              onResult({
                backend: 'gemini',
                model,
                sessionId: sid,
                costUsd: result.costUsd,
                durationMs: result.durationMs,
                cancelled: false,
                resultText: result.resultText,
              })
            },
            onError,
          })
        } catch {
          // ignore
        }
      }

      if (!resultReceived && code !== 0 && code !== null) {
        // If we have accumulated text, treat it as the result
        if (accumulated.trim()) {
          onResult({
            backend: 'gemini',
            model,
            sessionId: capturedSessionId,
            costUsd: 0,
            durationMs: Date.now() - active.startedAt,
            cancelled: false,
            resultText: accumulated,
          })
        } else {
          onError(`Gemini process exited with code ${code}`)
        }
      }
    })

    proc.on('error', (error) => {
      console.log('[gemini-runner] process error:', error.message)
      activeProcesses.delete(validatedPath)
      if (active.cancelled || resultReceived) return
      onError(`Failed to spawn Gemini: ${error.message}`)
    })
  },

  isRunning(projectPath?: string): boolean {
    if (projectPath) return activeProcesses.has(projectPath)
    return activeProcesses.size > 0
  },

  cancelRunning(projectPath?: string): boolean {
    if (projectPath) {
      const active = activeProcesses.get(projectPath)
      if (active) {
        active.cancelled = true
        active.proc.kill('SIGTERM')
        activeProcesses.delete(projectPath)
        return true
      }
      return false
    }
    if (activeProcesses.size === 0) return false
    for (const [key, active] of activeProcesses) {
      active.cancelled = true
      active.proc.kill('SIGTERM')
      activeProcesses.delete(key)
    }
    return true
  },

  getElapsedMs(projectPath: string): number {
    const active = activeProcesses.get(projectPath)
    return active ? Date.now() - active.startedAt : 0
  },
}

interface GeminiEventHandlers {
  readonly onInit: (sessionId: string | undefined) => void
  readonly onTextDelta: (text: string) => void
  readonly onToolUse: (toolName: string) => void
  readonly onResult: (result: { sessionId: string; costUsd: number; durationMs: number; resultText: string }) => void
  readonly onError: (error: string) => void
}

function handleGeminiEvent(event: GeminiStreamEvent, handlers: GeminiEventHandlers): void {
  switch (event.type) {
    case 'init': {
      handlers.onInit(event.session_id)
      break
    }
    case 'message': {
      // Skip user message echoes — only process assistant responses
      if (event.role === 'user') break
      // content is the text; delta is a boolean flag (not text)
      if (event.content) {
        handlers.onTextDelta(event.content)
      }
      break
    }
    case 'tool_use': {
      const name = event.tool_name ?? 'unknown'
      handlers.onToolUse(name)
      break
    }
    case 'error': {
      if (event.severity === 'error') {
        handlers.onError(event.message ?? 'Unknown Gemini error')
      }
      break
    }
    case 'result': {
      if (event.status === 'error') {
        const errMsg = event.error?.message ?? 'Unknown Gemini error'
        handlers.onError(errMsg)
      } else {
        handlers.onResult({
          sessionId: '',
          costUsd: 0,
          durationMs: event.stats?.duration_ms ?? 0,
          resultText: '',  // result event has no text — text comes from message events
        })
      }
      break
    }
  }
}
