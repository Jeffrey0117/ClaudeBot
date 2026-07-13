import { randomUUID } from 'node:crypto'
import type { AIRunner, AIRunOptions, AIBackend } from '../types.js'
import { getAISessionId, setAISessionId } from '../session-store.js'
import { env } from '../../config/env.js'
import { loadBatRemoteConfig } from './config.js'
import { BatRemoteClient, type BatRemoteEvent } from './client.js'

/**
 * `bat-remote` AI backend — drives a Better Agent Terminal (BAT) host over its
 * remote WebSocket protocol as a client. PoC: connect, start (or reuse) a Claude
 * SDK session on the host, send the prompt, and translate the host's broadcast
 * `event` stream into the AIRunner callbacks.
 *
 * See docs/bat-remote-protocol.md. Host-owned state: we never render optimistic
 * final state — the turn is resolved on the host's `turn-end` event, not on the
 * send-message ack.
 */

const BACKEND: AIBackend = 'bat-remote'
const MAX_ACCUMULATED_LENGTH = 100_000
// The send-message ack returns fast; this guards the whole turn in case a
// `turn-end` event never arrives (host stall / dropped session).
const TURN_TIMEOUT_MS = 5 * 60_000
const INVOKE_TIMEOUT_MS = 30_000

/** Stable per-process client identity (fine for a PoC; a persisted id would let
 *  the host dedupe its "new client" notification across restarts). */
const DEVICE_ID = randomUUID()

interface ActiveRun {
  readonly client: BatRemoteClient
  readonly startedAt: number
  cancelled: boolean
}

const activeRuns = new Map<string, ActiveRun>()

/** Strip the `agent:` / `claude:` namespace to get the bare event name. */
function eventName(channel: string): string {
  const colon = channel.indexOf(':')
  return colon === -1 ? channel : channel.slice(colon + 1)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export const batRemoteRunner: AIRunner = {
  backend: BACKEND,

  run(options: AIRunOptions): void {
    const { prompt, projectPath, onTextDelta, onToolUse, onResult, onError } = options

    const config = loadBatRemoteConfig()
    if (!config) {
      onError('bat-remote 未設定：請在 .env 填入 BAT_REMOTE_URL / BAT_REMOTE_TOKEN / BAT_REMOTE_FINGERPRINT，或在主機用 /pair bat 取碼後於本機跑 join-bat')
      return
    }
    if (activeRuns.has(projectPath)) {
      onError('bat-remote: a turn is already running for this project')
      return
    }

    const cwd = config.cwd || projectPath
    const client = new BatRemoteClient({
      url: config.url,
      token: config.token,
      fingerprint: config.fingerprint,
      label: 'ClaudeBot',
      windowId: `claudebot-${projectPath}`,
      deviceId: DEVICE_ID,
      appName: 'ClaudeBot',
      appVersion: '0.3.1',
    })
    const active: ActiveRun = { client, startedAt: Date.now(), cancelled: false }
    activeRuns.set(projectPath, active)

    let accumulated = ''
    let finished = false
    let turnTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null }
      activeRuns.delete(projectPath)
      client.removeAllListeners()
      client.close()
    }
    const finishOk = (sessionId: string, result: Record<string, unknown>): void => {
      if (finished) return
      finished = true
      cleanup()
      onResult({
        backend: BACKEND,
        model: options.model,
        sessionId,
        costUsd: typeof result.costUsd === 'number' ? result.costUsd : 0,
        durationMs: Date.now() - active.startedAt,
        cancelled: false,
        resultText: accumulated,
      })
    }
    const finishErr = (message: string): void => {
      if (finished) return
      finished = true
      cleanup()
      if (!active.cancelled) onError(message)
    }

    void (async () => {
      try {
        await client.connect()
      } catch (error) {
        finishErr(`bat-remote 連線失敗：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (active.cancelled) { cleanup(); return }

      // Reuse the host-side session across turns when we already have one;
      // otherwise start a fresh session with a client-generated id.
      let sessionId = getAISessionId(BACKEND, projectPath)
      const isNewSession = !sessionId
      if (!sessionId) sessionId = randomUUID()
      const activeSessionId = sessionId

      client.on('event', (evt: BatRemoteEvent) => {
        const params = evt.params
        if (params.sessionId !== activeSessionId) return // broadcasts reach all clients; filter to ours
        switch (eventName(evt.channel)) {
          case 'stream': {
            const data = asRecord(params.data)
            const text = typeof data.text === 'string' ? data.text : ''
            if (text) {
              accumulated += text
              if (accumulated.length > MAX_ACCUMULATED_LENGTH) {
                accumulated = accumulated.slice(-MAX_ACCUMULATED_LENGTH)
              }
              onTextDelta(text, accumulated)
            }
            break
          }
          case 'tool-use': {
            const toolCall = asRecord(params.toolCall)
            onToolUse(typeof toolCall.name === 'string' ? toolCall.name : 'tool')
            break
          }
          case 'turn-end': {
            setAISessionId(BACKEND, projectPath, activeSessionId)
            finishOk(activeSessionId, asRecord(params.payload))
            break
          }
          case 'result': {
            // Some hosts send `result` before `turn-end`; keep the usage summary
            // but let `turn-end` be the completion signal.
            break
          }
          case 'error': {
            const err = params.error
            finishErr(`bat-remote 回合錯誤：${typeof err === 'string' ? err : JSON.stringify(err)}`)
            break
          }
        }
      })
      client.on('close', () => finishErr('bat-remote: 連線在回合完成前中斷'))
      client.on('error', (error: Error) => finishErr(`bat-remote 連線錯誤：${error.message}`))

      turnTimer = setTimeout(() => finishErr('bat-remote: 等待 turn-end 逾時'), TURN_TIMEOUT_MS)

      try {
        if (isNewSession) {
          await client.invoke('agent:start-session', {
            sessionId: activeSessionId,
            options: { cwd, agentPreset: env.BAT_REMOTE_AGENT_PRESET },
          }, INVOKE_TIMEOUT_MS)
        }
        if (active.cancelled) { cleanup(); return }
        // Ack only — the reply is streamed back as events, resolved on turn-end.
        await client.invoke('agent:send-message', {
          sessionId: activeSessionId,
          prompt,
          ...(options.imagePaths.length > 0 ? { images: [...options.imagePaths] } : {}),
        }, INVOKE_TIMEOUT_MS)
      } catch (error) {
        finishErr(`bat-remote 送出訊息失敗：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  },

  isRunning(projectPath?: string): boolean {
    if (projectPath) return activeRuns.has(projectPath)
    return activeRuns.size > 0
  },

  cancelRunning(projectPath?: string): boolean {
    const cancelOne = (key: string, run: ActiveRun): void => {
      run.cancelled = true
      activeRuns.delete(key)
      run.client.removeAllListeners()
      run.client.close()
    }
    if (projectPath) {
      const run = activeRuns.get(projectPath)
      if (!run) return false
      cancelOne(projectPath, run)
      return true
    }
    if (activeRuns.size === 0) return false
    for (const [key, run] of activeRuns) cancelOne(key, run)
    return true
  },

  getElapsedMs(projectPath: string): number {
    const run = activeRuns.get(projectPath)
    return run ? Date.now() - run.startedAt : 0
  },
}
