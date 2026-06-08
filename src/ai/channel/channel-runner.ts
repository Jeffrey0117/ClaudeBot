import type { AIRunner, AIRunOptions } from '../types.js'
import type { SessionEvent } from './types.js'
import { ChannelSessionManager } from './session-manager.js'
import { LocalStreamJsonBackend } from './stream-json-backend.js'
import { resolveChannelLaunch } from './remote-launch.js'
import { getAISessionId, setAISessionId } from '../session-store.js'

// One manager process-wide; backend factory is the Phase 1 stream-json backend.
let manager = new ChannelSessionManager(() => new LocalStreamJsonBackend())

/** Test seam: swap the manager (and thus the backend factory). */
export function __setManagerForTest(m: ChannelSessionManager): void { manager = m }

/** Phase 1 session key = projectPath (activeMachine/threadId folded in later). */
function keyFor(projectPath: string): string { return projectPath }

export function isChannelRunning(projectPath?: string): boolean {
  if (!projectPath) return false
  return manager.isBusy(keyFor(projectPath))
}

/** /cancel on a channel project interrupts the turn (session survives). */
export function channelInterrupt(projectPath?: string): boolean {
  if (!projectPath) return false
  return manager.interrupt(keyFor(projectPath))
}

export const channelRunner: AIRunner = {
  backend: 'channel',

  run(opts: AIRunOptions): void {
    const { cfg: baseCfg, fingerprint } = resolveChannelLaunch({
      projectPath: opts.projectPath,
      model: opts.model,
      chatId: opts.chatId,
      threadId: opts.threadId,
      maxTurns: opts.maxTurns,
    })
    // Resume prior context on a COLD start (after idle-sweep / bot restart). A
    // warm session ignores this — runTurn reuses the live process, no start().
    const resumeSessionId = getAISessionId('channel', opts.projectPath) ?? undefined
    const cfg = resumeSessionId ? { ...baseCfg, resumeSessionId } : baseCfg
    let accumulated = ''
    const onEvent = (e: SessionEvent): void => {
      switch (e.kind) {
        case 'text-delta': accumulated += e.text; opts.onTextDelta(e.text, accumulated); break
        case 'tool-use': opts.onToolUse(e.toolName); break
        case 'result':
          if (e.result.sessionId) setAISessionId('channel', opts.projectPath, e.result.sessionId)
          opts.onResult({ ...e.result, backend: 'channel', model: opts.model })
          break
        case 'error': opts.onError(e.message); break
      }
    }
    void manager
      .runTurn(keyFor(opts.projectPath), cfg, fingerprint, opts.prompt, onEvent)
      .catch((err) => { opts.onError(err instanceof Error ? err.message : String(err)) })
  },

  isRunning(projectPath?: string): boolean { return isChannelRunning(projectPath) },
  cancelRunning(projectPath?: string): boolean { return channelInterrupt(projectPath) },
  getElapsedMs(): number { return 0 },
}
