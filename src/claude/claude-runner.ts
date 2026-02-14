import { spawn, execSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ClaudeModel, ClaudeResult } from '../types/index.js'
import type { StreamEvent, StreamResult, StreamContentBlockDelta, StreamAssistantMessage } from '../types/claude-stream.js'
import { setSessionId } from './session-store.js'
import { validateProjectPath } from '../utils/path-validator.js'
import { env } from '../config/env.js'

export type OnTextDelta = (text: string, accumulated: string) => void
export type OnToolUse = (toolName: string) => void
export type OnResult = (result: ClaudeResult) => void
export type OnError = (error: string) => void

interface RunOptions {
  readonly prompt: string
  readonly projectPath: string
  readonly model: ClaudeModel
  readonly sessionId: string | null
  readonly imagePaths: readonly string[]
  readonly onTextDelta: OnTextDelta
  readonly onToolUse: OnToolUse
  readonly onResult: OnResult
  readonly onError: OnError
}

function resolveClaudeCli(): { cmd: string; prefix: readonly string[] } {
  if (process.platform !== 'win32') {
    return { cmd: 'claude', prefix: [] }
  }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8' }).trim().split('\n')[0].trim()
    const dir = path.dirname(cmdPath)
    const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    return { cmd: process.execPath, prefix: [cliJs] }
  } catch {
    return { cmd: 'claude', prefix: [] }
  }
}

const claudeCli = resolveClaudeCli()
const MAX_ACCUMULATED_LENGTH = 100_000

interface ActiveProcess {
  readonly proc: ChildProcess
  readonly startedAt: number
  cancelled: boolean
}

const activeProcesses = new Map<string, ActiveProcess>()

export function isRunning(projectPath?: string): boolean {
  if (projectPath) {
    return activeProcesses.has(projectPath)
  }
  return activeProcesses.size > 0
}

export function cancelRunning(projectPath?: string): boolean {
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
}

export function getActiveProjects(): readonly string[] {
  return [...activeProcesses.keys()]
}

export function getElapsedMs(projectPath: string): number {
  const active = activeProcesses.get(projectPath)
  return active ? Date.now() - active.startedAt : 0
}

export function runClaude(options: RunOptions): void {
  const { prompt, projectPath, model, sessionId, imagePaths, onTextDelta, onToolUse, onResult, onError } =
    options

  let validatedPath: string
  try {
    validatedPath = validateProjectPath(projectPath)
  } catch (error) {
    onError(`Invalid project path: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const fullPrompt = imagePaths.length > 0
    ? `${prompt}\n\n[Attached images - use your Read tool to view them]:\n${imagePaths.map((p) => `- ${p}`).join('\n')}`
    : prompt

  const args = [
    '-p',
    fullPrompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--dangerously-skip-permissions',
  ]

  if (env.MAX_TURNS) {
    args.push('--max-turns', String(env.MAX_TURNS))
  }

  if (sessionId) {
    args.push('--resume', sessionId)
  }

  console.log('[claude-runner] spawning claude, cwd:', validatedPath)
  console.log('[claude-runner] prompt:', prompt.slice(0, 50))

  const proc = spawn(claudeCli.cmd, [...claudeCli.prefix, ...args], {
    cwd: validatedPath,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  console.log('[claude-runner] process spawned, pid:', proc.pid)

  const active: ActiveProcess = { proc, startedAt: Date.now(), cancelled: false }
  activeProcesses.set(validatedPath, active)
  let accumulated = ''
  let buffer = ''
  let resultReceived = false

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
            resultReceived = true
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
    console.log('[claude-runner] process closed, code:', code, 'project:', validatedPath, 'cancelled:', active.cancelled)
    activeProcesses.delete(validatedPath)

    // If cancelled or result already received, don't fire more callbacks
    if (active.cancelled || resultReceived) return

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
            resultReceived = true
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
    if (!resultReceived && code !== 0 && code !== null) {
      onError(`Claude process exited with code ${code}`)
    }
  })

  proc.on('error', (error) => {
    console.log('[claude-runner] process error:', error.message, 'cancelled:', active.cancelled)
    activeProcesses.delete(validatedPath)
    // Don't report errors if cancelled (expected) or already got result
    if (active.cancelled || resultReceived) return
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
    case 'assistant': {
      const msg = (event as StreamAssistantMessage).message
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            handlers.onTextDelta(block.text)
          } else if (block.type === 'tool_use' && block.name) {
            handlers.onToolUse(block.name)
          }
        }
      }
      break
    }
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
      console.log('[claude-runner] result.result length:', result.result?.length ?? 0, 'preview:', result.result?.slice(0, 100) ?? '(empty)')
      if (result.is_error) {
        handlers.onError(result.error ?? 'Unknown Claude error')
      } else {
        handlers.onResult({
          sessionId: result.session_id,
          costUsd: result.total_cost_usd ?? result.cost_usd ?? 0,
          durationMs: result.duration_ms,
          cancelled: false,
          resultText: result.result ?? '',
        })
      }
      break
    }
  }
}
