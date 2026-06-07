import { spawn, execSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import type { SessionBackend, SessionLaunchConfig, SessionEvent } from './types.js'
import type { StreamEvent, StreamResult, StreamAssistantMessage } from '../../types/claude-stream.js'

function resolveClaudeCli(): { cmd: string; prefix: readonly string[] } {
  if (process.platform !== 'win32') return { cmd: 'claude', prefix: [] }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim()
    const ccDir = path.join(path.dirname(cmdPath), 'node_modules', '@anthropic-ai', 'claude-code')
    const cliJs = path.join(ccDir, 'cli.js')
    if (fs.existsSync(cliJs)) return { cmd: process.execPath, prefix: [cliJs] }
    const binExe = path.join(ccDir, 'bin', 'claude.exe')
    if (fs.existsSync(binExe)) return { cmd: binExe, prefix: [] }
    return { cmd: 'claude', prefix: [] }
  } catch {
    return { cmd: 'claude', prefix: [] }
  }
}

const cli = resolveClaudeCli()

/** Phase 1 backend: persistent `claude -p --input-format stream-json`. */
export class LocalStreamJsonBackend implements SessionBackend {
  private proc: ChildProcess | null = null
  private buffer = ''
  private busy = false
  private interrupting = false
  private onEvent: ((e: SessionEvent) => void) | null = null
  private accumulated = ''
  private resolveTurn: (() => void) | null = null

  async start(cfg: SessionLaunchConfig): Promise<void> {
    const args = [
      ...cli.prefix,
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--model', cfg.model,
    ]
    if (cfg.systemPrompt) args.push('--append-system-prompt', cfg.systemPrompt)
    if (cfg.maxTurns) args.push('--max-turns', String(cfg.maxTurns))
    if (cfg.mcpConfigPaths.length) args.push('--mcp-config', ...cfg.mcpConfigPaths)
    if (cfg.disallowedTools?.length) args.push('--disallowedTools', cfg.disallowedTools.join(','))
    if (process.env.SKIP_PERMISSIONS) args.push('--dangerously-skip-permissions')

    this.proc = spawn(cli.cmd, args, {
      cwd: cfg.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc.stdout?.on('data', (c: Buffer) => { this.onStdout(c) })
    // Surface CLI startup/runtime errors (bad key, missing auth) that arrive on
    // stderr before any stream-json result — otherwise they'd be swallowed.
    this.proc.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim()
      if (msg) console.error('[channel-backend]', msg)
    })
    this.proc.on('close', () => { this.failTurn('channel session process closed'); this.proc = null })
    this.proc.on('error', (e) => { this.failTurn(`channel session spawn error: ${e.message}`) })
  }

  send(text: string, onEvent: (e: SessionEvent) => void): Promise<void> {
    if (!this.proc) return Promise.reject(new Error('session not started'))
    if (this.busy) return Promise.reject(new Error('turn already in flight'))
    this.onEvent = onEvent
    this.accumulated = ''
    this.busy = true
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    this.proc.stdin?.write(JSON.stringify(msg) + '\n')
    return new Promise<void>((resolve) => { this.resolveTurn = resolve })
  }

  async interrupt(): Promise<void> {
    if (!this.proc) return
    this.interrupting = true
    this.proc.stdin?.write(
      JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } }) + '\n',
    )
  }

  async stop(): Promise<void> {
    this.failTurn('session stopped')
    // Null proc BEFORE killing so a stale 'close' event (which fires async after
    // kill) sees no proc and failTurn() no-ops on an already-reset instance.
    const p = this.proc
    this.proc = null
    try { p?.stdin?.end() } catch { /* ignore */ }
    try { p?.kill('SIGTERM') } catch { /* ignore */ }
  }

  isBusy(): boolean { return this.busy }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      let event: StreamEvent
      try { event = JSON.parse(t) as StreamEvent } catch { continue }
      this.dispatch(event)
    }
  }

  private dispatch(event: StreamEvent): void {
    if (!this.onEvent) return
    switch (event.type) {
      case 'assistant': {
        // Sole text source: we do NOT pass --include-partial-messages, so the
        // CLI emits a complete `assistant` snapshot per turn and NO
        // content_block_delta events. Emitting text here only (and never from a
        // delta branch) guarantees no double emission.
        this.accumulated = ''
        const msg = (event as StreamAssistantMessage).message
        for (const block of msg?.content ?? []) {
          if (block.type === 'text' && block.text) {
            this.accumulated += block.text
            this.onEvent({ kind: 'text-delta', text: block.text })
          } else if (block.type === 'tool_use' && block.name) {
            this.onEvent({ kind: 'tool-use', toolName: block.name })
          }
        }
        break
      }
      case 'result': {
        const r = event as StreamResult
        if (r.is_error && this.interrupting) {
          // Expected: our interrupt produced error_during_execution → quiet cancel.
          this.onEvent({
            kind: 'result',
            result: {
              backend: 'channel',
              model: '',
              sessionId: r.session_id,
              costUsd: 0,
              durationMs: r.duration_ms,
              cancelled: true,
              resultText: '',
            },
          })
        } else if (r.is_error) {
          this.onEvent({ kind: 'error', message: r.errors?.[0] ?? r.error ?? 'channel turn error' })
        } else {
          const u = r.usage
          const contextTokens = u
            ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            : undefined
          this.onEvent({
            kind: 'result',
            result: {
              backend: 'channel',
              model: '',
              sessionId: r.session_id,
              costUsd: r.total_cost_usd ?? r.cost_usd ?? 0,
              durationMs: r.duration_ms,
              cancelled: false,
              resultText: r.result ?? '',
              contextTokens,
            },
          })
        }
        this.interrupting = false
        this.busy = false
        this.resolveTurn?.()
        this.resolveTurn = null
        break
      }
    }
  }

  private failTurn(message: string): void {
    if (this.busy && this.onEvent) this.onEvent({ kind: 'error', message })
    this.busy = false
    this.interrupting = false
    this.resolveTurn?.()
    this.resolveTurn = null
  }
}
