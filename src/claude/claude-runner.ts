import { spawn, execSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ClaudeModel, ClaudeResult } from '../types/index.js'
import type { StreamEvent, StreamResult, StreamContentBlockDelta, StreamAssistantMessage } from '../types/claude-stream.js'
import { setAISessionId } from '../ai/session-store.js'
import { validateProjectPath } from '../utils/path-validator.js'
import { getTodos } from '../bot/todo-store.js'
import { formatPinsForPrompt } from '../bot/context-pin-store.js'
import { getLastResponse } from '../bot/last-response-store.js'
import { buildContextInjection } from '../bot/context-digest-store.js'
import { getSystemPrompt } from '../utils/system-prompt.js'
import { env } from '../config/env.js'
import { getPairing } from '../remote/pairing-store.js'
import { getRelayPort } from '../remote/relay-server.js'
import { generateRemoteMcpConfig, cleanupRemoteMcpConfig } from '../remote/mcp-config-generator.js'

/** Detect affirmative/agreement replies that reference the previous message. */
const AFFIRMATIVE_RE = /^(好|可以|沒問題|沒差|OK|ok|Yes|yes|對|嗯|行|做吧|來吧|就這樣|同意|贊成|go|就醬|開始|動手|沒錯|是的|確定|sure|yep|yeah|做啊|加吧|弄吧|改吧|要|proceed|continue|繼續)/i

function looksAffirmative(text: string): boolean {
  const stripped = text.replace(/^[\[（(【]語音輸入[\]）)】]\s*/i, '').trim()
  return AFFIRMATIVE_RE.test(stripped)
}

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
  readonly chatId?: number
  readonly threadId?: number
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

  const parts: string[] = []

  // Inject project todos as context
  const todos = getTodos(validatedPath)
  const pendingTodos = todos.filter((t) => !t.done)
  if (pendingTodos.length > 0) {
    const todoLines = pendingTodos.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
    parts.push(`[專案待辦清單]\n${todoLines}`)
  }

  // Inject pinned context
  const pinnedContext = formatPinsForPrompt(validatedPath)
  if (pinnedContext) {
    parts.push(pinnedContext)
  }

  // Inject remote pairing context — only when REMOTE_ENABLED for this instance
  if (env.REMOTE_ENABLED && options.chatId) {
    const pairing = getPairing(options.chatId, options.threadId)
    if (pairing?.connected) {
      parts.push(
        `[遠端配對模式]\n` +
        `你已配對一台遠端電腦，所有操作都針對遠端。使用 remote_* MCP 工具：\n` +
        `\n` +
        `檔案操作：\n` +
        `- remote_read_file(path): 讀取檔案（限 500KB）\n` +
        `- remote_write_file(path, content): 寫入檔案\n` +
        `- remote_list_directory(path): 列出目錄\n` +
        `- remote_search_files(path, pattern, contentPattern?): 搜尋檔案\n` +
        `\n` +
        `搜尋與分析：\n` +
        `- remote_grep(pattern, path?, include?, maxResults?): 快速內容搜尋（正則、行號、自動排除 node_modules）\n` +
        `- remote_project_overview(path?): 一次看專案全貌（目錄樹 + CLAUDE.md + package.json + git status）\n` +
        `- remote_system_info(): 遠端系統資訊（OS、磁碟、記憶體、網路）\n` +
        `\n` +
        `執行與傳輸：\n` +
        `- remote_execute_command(command, cwd?): 執行任意指令\n` +
        `- remote_fetch_file(path): 下載檔案（base64，限 20MB）\n` +
        `- remote_push_file(path, base64): 上傳檔案（base64，限 20MB）\n` +
        `\n` +
        `規則：\n` +
        `1. 不要用 Read/Write/Edit/Bash 工具，那些是操作本地的。\n` +
        `2. 使用者可能在操作電腦（找檔案、傳東西、看狀態），不一定在做專案開發。根據需求選擇合適的工具。\n` +
        `3. 如果使用者要做專案開發，先用 remote_project_overview 了解專案全貌，特別是 CLAUDE.md。\n` +
        `4. 搜尋程式碼用 remote_grep，比 remote_search_files 快很多。\n` +
        `5. 修改檔案前先 remote_read_file 讀取完整內容。\n` +
        `\n` +
        `⚠️ 自我修改例外：\n` +
        `如果需要修改 ClaudeBot 專案本身的程式碼（當前工作目錄下的檔案），\n` +
        `一律使用本地工具（Read/Write/Edit/Bash），不要用 remote_* 工具。\n` +
        `判斷方式：改動需要「重啟 bot 才生效」→ 用本地工具。\n` +
        `[/遠端配對模式]`,
      )
    }
  }

  // For short or affirmative replies, inject context so Claude knows what
  // the user is referring to after context compression.
  // Prefers structured [CTX] digest; falls back to raw response tail.
  if (prompt.length <= 15 || (prompt.length <= 80 && looksAffirmative(prompt))) {
    const isAffirmative = looksAffirmative(prompt)
    const injection = buildContextInjection(validatedPath, isAffirmative)
    if (injection) {
      parts.push(injection)
    }
  }

  parts.push(prompt)

  if (imagePaths.length > 0) {
    parts.push(`[Attached images - use your Read tool to view them]:\n${imagePaths.map((p) => `- ${p}`).join('\n')}`)
  }

  const fullPrompt = parts.join('\n\n')

  const args = [
    '-p',
    fullPrompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ]

  if (env.SKIP_PERMISSIONS) {
    args.push('--dangerously-skip-permissions')
  }

  const systemPrompt = getSystemPrompt()
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt)
  }

  if (env.MAX_TURNS) {
    args.push('--max-turns', String(env.MAX_TURNS))
  }

  if (sessionId) {
    args.push('--resume', sessionId)
  }

  const mcpConfigs: string[] = []
  if (env.MCP_BROWSER) {
    mcpConfigs.push(path.resolve('data', 'mcp-browser.json'))
  }
  if (env.MCP_AGENT_BROWSER) {
    mcpConfigs.push(path.resolve('data', 'mcp-agent-browser.json'))
  }

  // Dynamic remote pairing MCP config — only when REMOTE_ENABLED
  let remoteMcpConfigPath: string | null = null
  if (env.REMOTE_ENABLED && options.chatId) {
    const pairing = getPairing(options.chatId, options.threadId)
    if (pairing?.connected) {
      const port = getRelayPort() || env.RELAY_PORT
      remoteMcpConfigPath = generateRemoteMcpConfig(port, pairing.code)
      mcpConfigs.push(remoteMcpConfigPath)
    }
  }

  if (mcpConfigs.length > 0) {
    args.push('--mcp-config', ...mcpConfigs)
  }

  console.log('[claude-runner] spawning claude, cwd:', validatedPath)
  console.log('[claude-runner] prompt:', prompt.slice(0, 50))

  const proc = spawn(claudeCli.cmd, [...claudeCli.prefix, ...args], {
    cwd: validatedPath,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
              setAISessionId('claude', validatedPath, result.sessionId)
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
    if (remoteMcpConfigPath) cleanupRemoteMcpConfig(remoteMcpConfigPath)

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
              setAISessionId('claude', validatedPath, result.sessionId)
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      onError('Claude CLI 未安裝。請先安裝：npm install -g @anthropic-ai/claude-code')
    } else {
      onError(`Claude CLI 啟動失敗: ${error.message}`)
    }
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
