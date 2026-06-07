import type { AIRunner, AIRunOptions } from '../types.js'
import type { SessionLaunchConfig, SessionEvent } from './types.js'
import { ChannelSessionManager } from './session-manager.js'
import { LocalStreamJsonBackend } from './stream-json-backend.js'
import { computeFingerprint } from './fingerprint.js'
import { getSystemPrompt } from '../../utils/system-prompt.js'

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
    const cfg: SessionLaunchConfig = {
      cwd: opts.projectPath,
      model: opts.model,
      systemPrompt: getSystemPrompt(),
      mcpConfigPaths: [],
      maxTurns: opts.maxTurns,
    }
    const fingerprint = computeFingerprint({
      model: opts.model, pairingCode: null, isAdmin: false, browser: false, systemPromptVersion: 1,
    })
    let accumulated = ''
    const onEvent = (e: SessionEvent): void => {
      switch (e.kind) {
        case 'text-delta': accumulated += e.text; opts.onTextDelta(e.text, accumulated); break
        case 'tool-use': opts.onToolUse(e.toolName); break
        case 'result': opts.onResult({ ...e.result, backend: 'channel', model: opts.model }); break
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
