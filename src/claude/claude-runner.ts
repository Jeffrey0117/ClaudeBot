import { spawn, type ChildProcess } from 'node:child_process'
import type { ClaudeModel, ClaudeResult } from '../types/index.js'
import type { StreamEvent, StreamResult, StreamContentBlockDelta } from '../types/claude-stream.js'
import { setSessionId } from './session-store.js'
import { validateProjectPath } from '../utils/path-validator.js'

export type OnTextDelta = (text: string, accumulated: string) => void
export type OnToolUse = (toolName: string) => void
export type OnResult = (result: ClaudeResult) => void
export type OnError = (error: string) => void

interface RunOptions {
  readonly prompt: string
  readonly projectPath: string
  readonly model: ClaudeModel
  readonly sessionId: string | null
  readonly onTextDelta: OnTextDelta
  readonly onToolUse: OnToolUse
  readonly onResult: OnResult
  readonly onError: OnError
}

const MAX_ACCUMULATED_LENGTH = 100_000

let activeProcess: ChildProcess | null = null

export function isRunning(): boolean {
  return activeProcess !== null
}

export function cancelRunning(): boolean {
  if (activeProcess) {
    activeProcess.kill('SIGTERM')
    activeProcess = null
    return true
  }
  return false
}

export function runClaude(options: RunOptions): void {
  const { prompt, projectPath, model, sessionId, onTextDelta, onToolUse, onResult, onError } =
    options

  let validatedPath: string
  try {
    validatedPath = validateProjectPath(projectPath)
  } catch (error) {
    onError(`Invalid project path: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ]

  if (sessionId) {
    args.push('--resume', sessionId)
  }

  console.log('[claude-runner] spawning claude, cwd:', validatedPath)
  console.log('[claude-runner] prompt:', prompt.slice(0, 50))

  const proc = spawn('claude', args, {
    cwd: validatedPath,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  console.log('[claude-runner] process spawned, pid:', proc.pid)
  console.log('[claude-runner] stdout exists:', !!proc.stdout)
  console.log('[claude-runner] stderr exists:', !!proc.stderr)

  activeProcess = proc
  let accumulated = ''
  let buffer = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    console.log('[claude-runner] stdout chunk:', chunk.length, 'bytes')
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const event = JSON.parse(trimmed) as StreamEvent
        console.log('[claude-runner] event type:', event.type, 'subtype' in event ? (event as any).subtype : '')
        handleStreamEvent(event, {
          onTextDelta: (text) => {
            accumulated += text
            if (accumulated.length > MAX_ACCUMULATED_LENGTH) {
              accumulated = accumulated.slice(-MAX_ACCUMULATED_LENGTH)
            }
            onTextDelta(text, accumulated)
          },
          onToolUse,
          onResult: (result) => {
            try {
              setSessionId(validatedPath, result.sessionId)
            } catch (err) {
              console.error('Failed to save session ID:', err)
            }
            onResult(result)
          },
          onError,
        })
      } catch {
        // skip non-JSON lines
      }
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    console.log('[claude-runner] stderr:', chunk.toString().trim())
  })

  proc.on('close', (code) => {
    console.log('[claude-runner] process closed, code:', code)
    activeProcess = null
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim()) as StreamEvent
        handleStreamEvent(event, {
          onTextDelta: (text) => {
            accumulated += text
            if (accumulated.length > MAX_ACCUMULATED_LENGTH) {
              accumulated = accumulated.slice(-MAX_ACCUMULATED_LENGTH)
            }
            onTextDelta(text, accumulated)
          },
          onToolUse,
          onResult: (result) => {
            try {
              setSessionId(validatedPath, result.sessionId)
            } catch (err) {
              console.error('Failed to save session ID:', err)
            }
            onResult(result)
          },
          onError,
        })
      } catch {
        // ignore
      }
    }
    if (code !== 0 && code !== null) {
      onError(`Claude process exited with code ${code}`)
    }
  })

  proc.on('error', (error) => {
    activeProcess = null
    onError(`Failed to spawn Claude: ${error.message}`)
  })
}

interface EventHandlers {
  readonly onTextDelta: (text: string) => void
  readonly onToolUse: OnToolUse
  readonly onResult: OnResult
  readonly onError: OnError
}

function handleStreamEvent(event: StreamEvent, handlers: EventHandlers): void {
  switch (event.type) {
    case 'content_block_delta': {
      const delta = event as StreamContentBlockDelta
      if (delta.delta.type === 'text_delta' && delta.delta.text) {
        handlers.onTextDelta(delta.delta.text)
      }
      break
    }
    case 'content_block_start': {
      if (event.content_block.type === 'tool_use' && event.content_block.name) {
        handlers.onToolUse(event.content_block.name)
      }
      break
    }
    case 'result': {
      const result = event as StreamResult
      if (result.is_error) {
        handlers.onError(result.error ?? 'Unknown Claude error')
      } else {
        handlers.onResult({
          sessionId: result.session_id,
          costUsd: result.cost_usd,
          durationMs: result.duration_ms,
          cancelled: false,
        })
      }
      break
    }
  }
}
