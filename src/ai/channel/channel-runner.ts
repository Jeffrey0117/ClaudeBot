import type { AIRunner, AIRunOptions } from '../types.js'
import type { SessionEvent } from './types.js'
import { ChannelSessionManager } from './session-manager.js'
import { LocalStreamJsonBackend } from './stream-json-backend.js'
import { resolveChannelLaunch } from './remote-launch.js'
import { getAISessionId, setAISessionId, clearAISession, normalizeProjectKey } from '../session-store.js'
import { buildMemoryParts, buildDigestParts } from '../../utils/context-parts.js'

// One manager process-wide; backend factory is the Phase 1 stream-json backend.
let manager = new ChannelSessionManager(() => new LocalStreamJsonBackend())

/** Test seam: swap the manager (and thus the backend factory). */
export function __setManagerForTest(m: ChannelSessionManager): void { manager = m }

/**
 * Phase 1 session key = projectPath (activeMachine/threadId folded in later),
 * canonicalized so the two Windows path spellings map to one warm session.
 */
function keyFor(projectPath: string): string { return normalizeProjectKey(projectPath) }

/**
 * Full reset for /new and /context clear.
 *
 * Clearing the stored id is not enough on this backend: the warm CLI process
 * holds the conversation in memory and runTurn reuses it without consulting
 * resumeSessionId. So /new used to report "已清除" while the next message
 * landed in the very same session with all the old context.
 */
export async function channelReset(projectPath: string): Promise<void> {
  clearAISession('channel', projectPath)
  await manager.stop(keyFor(projectPath))
}

export function isChannelRunning(projectPath?: string): boolean {
  if (!projectPath) return false
  return manager.isBusy(keyFor(projectPath))
}

/** /cancel on a channel project interrupts the turn (session survives). */
export function channelInterrupt(projectPath?: string): boolean {
  if (!projectPath) return false
  return manager.interrupt(keyFor(projectPath))
}

/** The CLI's wording when a resumed conversation no longer exists on disk. */
export function isStaleSessionError(message: string): boolean {
  return message.includes('No conversation found')
}

export const channelRunner: AIRunner = {
  backend: 'channel',

  run(opts: AIRunOptions): void {
    runChannelTurn(opts, true)
  },

  isRunning(projectPath?: string): boolean { return isChannelRunning(projectPath) },
  cancelRunning(projectPath?: string): boolean { return channelInterrupt(projectPath) },
  getElapsedMs(): number { return 0 },
}

/**
 * One channel turn, with stale-session recovery.
 *
 * A stored session id can outlive the conversation it points at (the transcript
 * is deleted, or the worktree it belonged to never had one). A WARM session
 * ignores resumeSessionId entirely, so a dangling id can sit unnoticed for
 * weeks and only bites on the next cold start — which is exactly what a bot
 * restart causes. claude-runner already clears and retries in that case; this
 * backend did not, so the raw "No conversation found with session ID: ..." was
 * surfaced to the user and every following turn failed the same way, with no
 * way out short of /new.
 */
function runChannelTurn(opts: AIRunOptions, allowResume: boolean): void {
  const { cfg: baseCfg, fingerprint } = resolveChannelLaunch({
    projectPath: opts.projectPath,
    model: opts.model,
    chatId: opts.chatId,
    threadId: opts.threadId,
    maxTurns: opts.maxTurns,
  })
  // Resume prior context on a COLD start (after idle-sweep / bot restart). A
  // warm session ignores this — runTurn reuses the live process, no start().
  const resumeSessionId = allowResume
    ? getAISessionId('channel', opts.projectPath) ?? undefined
    : undefined
  const cfg = resumeSessionId ? { ...baseCfg, resumeSessionId } : baseCfg

    // Per-turn memory. This backend used to pass opts.prompt straight through,
    // so pins, @learn rules and project todos were stored and confirmed to the
    // user but never actually reached the model on the default path.
    const key = keyFor(opts.projectPath)
    const coldStart = !manager.hasSession(key) && !resumeSessionId
    const prompt = [
      ...buildMemoryParts({
        contextKey: opts.projectPath,
        projectName: opts.projectName,
        displayPath: opts.projectPath,
      }),
      ...buildDigestParts({
        contextKey: opts.projectPath,
        prompt: opts.prompt,
        isNewSession: coldStart,
      }),
      opts.prompt,
    ].join('\n\n')

  let accumulated = ''
  let handled = false

  /**
   * Drop the dangling id and run the turn again cold, once.
   * Returns true when recovery took over, so the caller must not report.
   */
  const recoverFromStaleSession = (message: string): boolean => {
    if (handled) return true
    if (!resumeSessionId || !isStaleSessionError(message)) return false
    handled = true
    console.error(
      `[channel] stored session ${resumeSessionId} no longer exists — clearing and retrying cold`,
    )
    clearAISession('channel', opts.projectPath)
    // Drop the warm entry too: it was started with the bad resume id
    void manager.stop(keyFor(opts.projectPath)).catch(() => {})
    // Tell the UI the bot just lost its memory, same as the Claude backend does
    try { opts.onStaleRetry?.() } catch { /* best effort */ }
    runChannelTurn(opts, false)
    return true
  }

  const onEvent = (e: SessionEvent): void => {
    switch (e.kind) {
      case 'text-delta': accumulated += e.text; opts.onTextDelta(e.text, accumulated); break
      case 'tool-use': opts.onToolUse(e.toolName); break
      case 'result':
        if (handled) return
        handled = true
        if (e.result.sessionId) setAISessionId('channel', opts.projectPath, e.result.sessionId)
        opts.onResult({ ...e.result, backend: 'channel', model: opts.model })
        break
      case 'error':
        if (recoverFromStaleSession(e.message)) return
        handled = true
        opts.onError(e.message)
        break
    }
  }
  void manager
    .runTurn(key, cfg, fingerprint, prompt, onEvent)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      if (recoverFromStaleSession(message)) return
      if (handled) return
      handled = true
      opts.onError(message)
    })
}
