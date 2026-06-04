import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import fs from 'node:fs'
import type { ClaudeModel, ClaudeResult } from '../types/index.js'
import type { StreamEvent, StreamResult, StreamContentBlockDelta, StreamAssistantMessage } from '../types/claude-stream.js'
import { setAISessionId, clearAISession } from '../ai/session-store.js'
import { validateProjectPath } from '../utils/path-validator.js'
import { getTodos } from '../bot/todo-store.js'
import { formatPinsForPrompt, touchPins } from '../bot/context-pin-store.js'
import { formatRulesForPrompt, touchLearnedRules } from '../bot/learned-rules-store.js'
import { getLastResponse } from '../bot/last-response-store.js'
import { buildContextInjection } from '../bot/context-digest-store.js'
import { getSystemPrompt } from '../utils/system-prompt.js'
import { env } from '../config/env.js'
import { getPairing, getPairings, isRemotePath } from '../remote/pairing-store.js'
import { getActiveMachine } from '../bot/state.js'
import { getRelayPort, getAgentBaseDir } from '../remote/relay-server.js'
import { generateRemoteMcpConfig, cleanupRemoteMcpConfig } from '../remote/mcp-config-generator.js'
import { isVirtualChat, getVirtualChatPairingCode, getVirtualChatLicenseKey } from '../remote/virtual-chat-store.js'
import { isAdminLicense } from '../remote/license-store.js'

/** Detect affirmative/agreement replies that reference the previous message. */
const AFFIRMATIVE_RE = /^(好|可以|沒問題|沒差|OK|ok|Yes|yes|對|嗯|行|做吧|來吧|就這樣|同意|贊成|go|就醬|開始|動手|沒錯|是的|確定|sure|yep|yeah|做啊|加吧|弄吧|改吧|要|proceed|continue|繼續)/i
const AFFIRMATIVE_EMOJI = /^[👍✅✔️👌🫡💪🤙☑️]+$/u

function looksAffirmative(text: string): boolean {
  const stripped = text.replace(/^[\[（(【]語音輸入[\]）)】]\s*/i, '').trim()
  if (AFFIRMATIVE_EMOJI.test(stripped)) return true
  return AFFIRMATIVE_RE.test(stripped)
}

export type OnTextDelta = (text: string, accumulated: string) => void
export type OnToolUse = (toolName: string) => void
export type OnResult = (result: ClaudeResult) => void
export type OnError = (error: string) => void

interface RunOptions {
  readonly prompt: string
  readonly projectPath: string
  readonly projectName?: string
  readonly model: ClaudeModel
  readonly sessionId: string | null
  readonly imagePaths: readonly string[]
  readonly chatId?: number
  readonly threadId?: number
  readonly maxTurns?: number
  /** Internal: counts auto-retries for transient spawn failures (libuv errors). */
  readonly _retryCount?: number
  readonly onTextDelta: OnTextDelta
  readonly onToolUse: OnToolUse
  readonly onResult: OnResult
  readonly onError: OnError
  readonly onStaleRetry?: () => void
}

function resolveClaudeCli(): { cmd: string; prefix: readonly string[] } {
  if (process.platform !== 'win32') {
    return { cmd: 'claude', prefix: [] }
  }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim()
    const dir = path.dirname(cmdPath)
    const ccDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
    // claude-code <= 1.x shipped cli.js (run via node); 2.x ships a native bin/claude.exe
    const cliJs = path.join(ccDir, 'cli.js')
    if (fs.existsSync(cliJs)) {
      return { cmd: process.execPath, prefix: [cliJs] }
    }
    const binExe = path.join(ccDir, 'bin', 'claude.exe')
    if (fs.existsSync(binExe)) {
      return { cmd: binExe, prefix: [] }
    }
    return { cmd: 'claude', prefix: [] }
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

/**
 * Build remote tool documentation for system prompt.
 * Moved from user message to system prompt to save ~2K tokens per turn.
 */
function buildRemoteSystemBlock(
  isAdmin: boolean,
  remoteBaseDir: string | undefined,
  hasBrowser: boolean,
): string {
  return (
    `[遠端配對模式]\n` +
    (remoteBaseDir ? `遠端工作目錄: ${remoteBaseDir}\n` : '') +
    `你已配對一台遠端電腦，所有操作都針對遠端。使用 remote_* MCP 工具：\n` +
    `\n` +
    `檔案操作：\n` +
    `- remote_read_file(path, offset?, limit?): 讀取檔案（限 500KB，支援 byte-range 區段讀取）\n` +
    `- remote_write_file(path, content): 寫入檔案\n` +
    `- remote_list_directory(path): 列出目錄（含檔案大小和修改時間）\n` +
    `- remote_search_files(path, pattern, contentPattern?): 搜尋檔案\n` +
    `- remote_delete(path, recursive?): 刪除檔案或目錄（目錄需 recursive:true）\n` +
    `- remote_move_file(src, dest): 移動/重新命名檔案\n` +
    `\n` +
    `搜尋與分析：\n` +
    `- remote_grep(pattern, path?, include?, maxResults?): 快速內容搜尋（正則、行號、自動排除 node_modules）\n` +
    `- remote_project_overview(path?): 一次看專案全貌（目錄樹 + CLAUDE.md + package.json + git status）\n` +
    `- remote_system_info(): 遠端系統資訊（OS、磁碟、記憶體、網路）\n` +
    `\n` +
    `執行與傳輸：\n` +
    `- remote_execute_command(command, cwd?): 執行會「結束」的指令並拿輸出（隱藏視窗、會等到結束或 timeout）\n` +
    `- remote_fetch_file(path): 下載檔案（base64，限 20MB）\n` +
    `- remote_push_file(path, base64): 上傳檔案（base64，限 20MB）\n` +
    `- remote_fetch_archive(path, format?): 壓縮下載（zip/tar.gz，限 20MB）\n` +
    `- remote_spawn_detached(command, cwd?): 啟動 GUI 程式 / 長駐服務（視窗會出現在使用者桌面、立即返回不阻塞）\n` +
    `\n` +
    `⚠️ 開 app/GUI（小畫家、瀏覽器、記事本…）或啟動服務 → 一律用 remote_spawn_detached（可見、秒回）。\n` +
    `   絕對不要用 remote_execute_command 開 GUI：它會隱藏視窗、又卡到 timeout（30 秒）才回，又慢又像沒開。\n` +
    `\n` +
    `系統互動：\n` +
    `- remote_clipboard(action, text?): 讀寫剪貼簿（action: "read"/"write"）\n` +
    `- remote_notify(title, body): 桌面通知\n` +
    `\n` +
    (isAdmin
      ? `[雙機器模式]\n` +
        `你可以同時操作兩台機器：\n` +
        `\n` +
        `  🖥️ 本機（Bot 伺服器）\n` +
        `     路徑: ${process.cwd()}\n` +
        `     工具: Read, Write, Edit, Bash, Glob, Grep\n` +
        `\n` +
        `  💻 遠端（使用者的電腦）\n` +
        (remoteBaseDir ? `     路徑: ${remoteBaseDir}\n` : '') +
        `     工具: remote_* 系列\n` +
        `\n` +
        `判斷規則（按優先序）：\n` +
        `1. 使用者明確指定 → 照做\n` +
        `   本機關鍵字：「本地」「伺服器」「bot 那台」「這台伺服器」「A機器」(若已定義)\n` +
        `   遠端關鍵字：「遠端」「我的電腦」「那邊」「B機器」(若已定義)\n` +
        `2. 使用者用自定義名稱（如「A機器」「B機器」）→ 從上下文推斷是哪台，並在回覆中確認\n` +
        `3. 路徑來自 remote_* 工具的回傳 → 一定是遠端路徑 → 用 remote_*\n` +
        `4. 沒有明確指定 → 預設用遠端工具\n` +
        `\n` +
        `⚠️ 跨機器工作流：\n` +
        `- 切換機器時，在回覆中明確標示：「現在切到本機操作」「切回遠端」\n` +
        `- 如果 Read/Bash 出現 "no such file" → 你可能用錯機器了，改用 remote_* 重試\n` +
        `- 跨機器傳檔：remote_read_file → Write（遠端→本機）或 Read → remote_write_file（本機→遠端）\n` +
        `[/雙機器模式]\n`
      : `[單機遠端模式]\n` +
        `⚠️ 嚴禁使用本地工具（Read/Write/Edit/Bash/Glob/Grep）！\n` +
        `你的本地檔案系統是 Bot 伺服器，不是使用者的電腦。\n` +
        `對話中所有路徑都在使用者的遠端機器上 → 只能用 remote_* 工具。\n` +
        `"no such file" / ENOENT = 你用錯了工具。\n` +
        `\n` +
        `唯一例外：修改 ClaudeBot 自身程式碼（需重啟 bot 才生效的改動）→ 用本地工具。\n` +
        `[/單機遠端模式]\n`) +
    `\n` +
    `操作守則：\n` +
    `1. 使用者可能在操作電腦（找檔案、傳東西、看狀態），不一定在做專案開發。\n` +
    `2. 做專案開發時，先用 remote_project_overview 了解全貌，特別是 CLAUDE.md。\n` +
    `3. 搜尋程式碼用 remote_grep，比 remote_search_files 快很多。\n` +
    `4. 修改檔案前先 remote_read_file 讀取完整內容。\n` +
    `\n` +
    (hasBrowser
      ? `瀏覽器操作（遠端機器）：\n` +
        `- ab_connect_browser(): 連接使用者的 Chrome（帶登入狀態）。需要登入的網站必須先呼叫。\n` +
        `- ab_open(url): 開啟網頁\n` +
        `- ab_snapshot(): 取得頁面元素清單（互動元素 ref）\n` +
        `- ab_click(ref): 點擊元素\n` +
        `- ab_fill(ref, text): 填寫輸入欄位\n` +
        `- ab_press(key): 按鍵（Enter, Escape, Tab）\n` +
        `- ab_screenshot(): 截圖（頁面截圖）\n` +
        `- ab_back(): 回上一頁\n` +
        `- ab_get_url(): 取得當前網址\n` +
        `\n` +
        `瀏覽器使用規則（嚴格遵守，不要自行發明替代方案）：\n` +
        `1. 需要登入的網站 → ab_connect_browser() → ab_open(url) → ab_snapshot() → 操作\n` +
        `2. 不需要登入 → 直接 ab_open(url)\n` +
        `3. ab_connect_browser 內部會：殺 daemon → 關 Chrome → 刪 lockfile → 重開帶 CDP → 確認連線。\n` +
        `   你只需要呼叫一次，不要自己用 remote_execute_command 去殺 Chrome 或改設定。\n` +
        `4. 如果 ab_connect_browser 失敗，直接回報錯誤訊息。不要自行嘗試修復。\n` +
        `5. 如果 ab_* 工具 timeout，可能是頁面太重。用 ab_screenshot 確認狀態後再操作。\n` +
        `6. 絕對不要建議使用者「手動操作」。你有完整的瀏覽器控制能力，用它。\n` +
        `\n`
      : '') +
    `[/遠端配對模式]`
  )
}

export function runClaude(options: RunOptions): void {
  const { prompt, projectPath, model, sessionId, imagePaths, onTextDelta, onToolUse, onResult, onError } =
    options

  // Remote machine paths (remote:label) use bot's cwd as CLI working directory
  let validatedPath: string
  if (isRemotePath(projectPath)) {
    validatedPath = process.cwd()
  } else {
    try {
      validatedPath = validateProjectPath(projectPath)
    } catch (error) {
      onError(`Invalid project path: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }

  // contextKey = projectPath (remote:xxx or real path) — used for all context store lookups
  // This MUST match what queue-processor uses for setContext/setLastResponse,
  // otherwise remote sessions get amnesia (stores use remote:xxx, lookups use cwd).
  const contextKey = projectPath
  let remoteSystemBlock: string | null = null

  const parts: string[] = []

  // Inject project todos as context
  const todos = getTodos(contextKey)
  const pendingTodos = todos.filter((t) => !t.done)
  if (pendingTodos.length > 0) {
    const todoLines = pendingTodos.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
    parts.push(`[專案待辦清單]\n${todoLines}`)
  }

  // Inject pinned context + track usage
  const pinnedContext = formatPinsForPrompt(contextKey)
  if (pinnedContext) {
    touchPins(contextKey)
    parts.push(pinnedContext)
  }

  // Inject learned behavior rules
  const rulesContext = formatRulesForPrompt(contextKey)
  if (rulesContext) {
    touchLearnedRules(contextKey)
    parts.push(rulesContext)
  }

  // Inject current project context (so Claude knows which project it's working on)
  if (options.projectName) {
    const projectLine = isRemotePath(projectPath)
      ? `[當前專案: ${options.projectName}]\n路徑: ${projectPath.replace(/^remote:/, '')}`
      : `[當前專案: ${options.projectName}]\n路徑: ${projectPath}`
    parts.push(projectLine)
  }

  // Inject remote pairing context — Telegram users need REMOTE_ENABLED,
  // but Electron virtual chats are ALWAYS remote by definition
  if (options.chatId) {
    const activeMch = getActiveMachine(options.chatId, options.threadId)
    const pairing = env.REMOTE_ENABLED ? getPairing(options.chatId, options.threadId, activeMch) : null
    const isRemote = pairing?.connected === true || isVirtualChat(options.chatId)
    const isAdmin = env.ADMIN_CHAT_ID === options.chatId ||
      (isVirtualChat(options.chatId) && isAdminLicense(getVirtualChatLicenseKey(options.chatId) ?? ''))
    if (isRemote) {
      // Look up agent baseDir for remote prompt context
      let remoteBaseDir: string | undefined
      const pairingForBaseDir = pairing
      if (pairingForBaseDir?.connected) {
        remoteBaseDir = getAgentBaseDir(pairingForBaseDir.code)
      } else if (isVirtualChat(options.chatId!)) {
        const vcCode = getVirtualChatPairingCode(options.chatId!)
        if (vcCode) remoteBaseDir = getAgentBaseDir(vcCode)
      }

      // Remote tool docs → system prompt (saves ~2K per user turn)
      remoteSystemBlock = buildRemoteSystemBlock(isAdmin, remoteBaseDir, !!env.MCP_AGENT_BROWSER)
      // Compact user-message indicator (full tool docs in system prompt)
      parts.push(
        `[遠端模式]` +
        (remoteBaseDir ? ` 工作目錄: ${remoteBaseDir}` : '') +
        (isAdmin ? ` | 本機: ${process.cwd()}` : '') +
        `[/遠端模式]`,
      )
    }
  }

  // For short or affirmative replies, inject context so Claude knows what
  // the user is referring to after context compression.
  // Prefers structured [CTX] digest; falls back to raw response tail.
  if (prompt.length <= 15 || (prompt.length <= 80 && looksAffirmative(prompt))) {
    const isAffirmative = looksAffirmative(prompt)
    const injection = buildContextInjection(contextKey, isAffirmative)
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
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ]

  if (env.SKIP_PERMISSIONS) {
    args.push('--dangerously-skip-permissions')
  }

  const baseSystemPrompt = getSystemPrompt()
  const systemPrompt = remoteSystemBlock
    ? (baseSystemPrompt ? `${baseSystemPrompt}\n\n${remoteSystemBlock}` : remoteSystemBlock)
    : baseSystemPrompt
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt)
  }

  const effectiveMaxTurns = options.maxTurns ?? env.MAX_TURNS
  if (effectiveMaxTurns) {
    args.push('--max-turns', String(effectiveMaxTurns))
  }

  if (sessionId) {
    args.push('--resume', sessionId)
  }

  // Determine if this is a remote session (paired Telegram user OR virtual Electron chat)
  // Virtual Electron chats are ALWAYS remote — no REMOTE_ENABLED gate needed
  const activeMchForSession = options.chatId ? getActiveMachine(options.chatId, options.threadId) : undefined
  const isRemoteSession = options.chatId && (
    (env.REMOTE_ENABLED && getPairing(options.chatId, options.threadId, activeMchForSession)?.connected === true) ||
    isVirtualChat(options.chatId)
  )

  const mcpConfigs: string[] = []
  if (env.MCP_BROWSER) {
    mcpConfigs.push(path.resolve('data', 'mcp-browser.json'))
  }
  // Local agent-browser only when NOT remote — remote proxy provides ab_* tools
  if (env.MCP_AGENT_BROWSER && !isRemoteSession) {
    mcpConfigs.push(path.resolve('data', 'mcp-agent-browser.json'))
  }

  // Dynamic remote pairing MCP config — find the agent's code
  let remoteMcpConfigPath: string | null = null
  if (isRemoteSession && options.chatId) {
    let remoteCode: string | null = null
    const mcpPairing = getPairing(options.chatId, options.threadId, activeMchForSession)
    if (mcpPairing?.connected) {
      remoteCode = mcpPairing.code
    } else if (isVirtualChat(options.chatId)) {
      // Virtual Electron chat — look up the agent's code from virtual-chat-store
      remoteCode = getVirtualChatPairingCode(options.chatId)
    }
    if (remoteCode) {
      const port = getRelayPort() || env.RELAY_PORT
      remoteMcpConfigPath = generateRemoteMcpConfig(port, remoteCode)
      mcpConfigs.push(remoteMcpConfigPath)
    }
  }

  if (mcpConfigs.length > 0) {
    args.push('--mcp-config', ...mcpConfigs)
  }

  // Hard isolation: a non-admin remote session gets NO local-host tools —
  // only the remote_* MCP tools (which reach the user's own machine). Admins
  // (ADMIN_CHAT_ID or admin license key) keep dual-machine local+remote.
  // Enforces "no admin key ⇒ remote can't touch the bot host" at the CLI
  // level, not just via the system prompt.
  if (isRemoteSession) {
    const isAdminSession = env.ADMIN_CHAT_ID === options.chatId ||
      (!!options.chatId && isVirtualChat(options.chatId) &&
        isAdminLicense(getVirtualChatLicenseKey(options.chatId) ?? ''))
    if (!isAdminSession) {
      args.push('--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,NotebookEdit')
    }
  }

  console.log('[claude-runner] spawning claude, cwd:', validatedPath)
  console.log('[claude-runner] prompt length:', fullPrompt.length, 'preview:', prompt.slice(0, 50))

  // Guard against ENOENT (-4058) at spawn time: the cwd can momentarily vanish
  // during git auto-sync / worktree operations. Fail with a clear message
  // instead of a raw libuv error code.
  if (!existsSync(validatedPath)) {
    onError(`專案目錄暫時無法存取：${validatedPath}（可能正在同步，請稍後重試）`)
    return
  }

  const proc = spawn(claudeCli.cmd, [...claudeCli.prefix, ...args], {
    cwd: validatedPath,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // Pipe prompt via stdin to avoid Windows 32K command-line length limit
  proc.stdin?.write(fullPrompt)
  proc.stdin?.end()

  console.log('[claude-runner] process spawned, pid:', proc.pid)

  const active: ActiveProcess = { proc, startedAt: Date.now(), cancelled: false }
  activeProcesses.set(validatedPath, active)
  let accumulated = ''
  let buffer = ''
  let resultReceived = false

  // Auto-retry: if session is stale, clear it and re-run without --resume
  const onErrorWithRetry = (error: string) => {
    if (sessionId && error.includes('No conversation found')) {
      console.log('[claude-runner] stale session detected, clearing and retrying without --resume')
      clearAISession('claude', validatedPath)
      activeProcesses.delete(validatedPath)
      // Notify the UI layer BEFORE retrying so the user knows the bot just forgot
      try { options.onStaleRetry?.() } catch {}
      runClaude({ ...options, sessionId: null })
      return
    }
    onError(error)
  }

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
          onNewTurn: () => { accumulated = '' },
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
          onError: onErrorWithRetry,
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
          onNewTurn: () => { accumulated = '' },
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
          onError: onErrorWithRetry,
        })
      } catch {
        // ignore
      }
    }
    if (!resultReceived && code !== 0 && code !== null) {
      // Negative codes are libuv spawn errors (e.g. -4058 = ENOENT: cwd or CLI
      // momentarily missing — usually a transient race during git auto-sync).
      if (code < 0) {
        const retry = options._retryCount ?? 0
        if (retry < 1 && existsSync(validatedPath)) {
          console.log(`[claude-runner] transient spawn failure (${code}), retrying once in 1.5s`)
          setTimeout(() => runClaude({ ...options, _retryCount: retry + 1 }), 1500)
          return
        }
        const reason = code === -4058
          ? '工作目錄或 Claude CLI 暫時找不到 (ENOENT)'
          : `系統錯誤 ${code}`
        onError(`Claude 啟動失敗：${reason}。請重試，若持續發生請檢查專案路徑是否存在。`)
        return
      }
      onErrorWithRetry(`Claude process exited with code ${code}`)
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
  readonly onNewTurn?: () => void
}

function handleStreamEvent(event: StreamEvent, handlers: EventHandlers): void {
  switch (event.type) {
    case 'assistant': {
      // New assistant turn — reset accumulated to avoid leaking
      // intermediate thinking text from previous turns
      handlers.onNewTurn?.()
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
        const errorMsg = result.errors?.[0] ?? result.error ?? 'Unknown Claude error'
        handlers.onError(errorMsg)
      } else {
        const u = result.usage
        const contextTokens = u
          ? (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0)
          : undefined
        handlers.onResult({
          sessionId: result.session_id,
          costUsd: result.total_cost_usd ?? result.cost_usd ?? 0,
          durationMs: result.duration_ms,
          cancelled: false,
          resultText: result.result ?? '',
          contextTokens,
        })
      }
      break
    }
  }
}
