import type { AIResult } from '../types.js'

/** Everything bound at session launch (cannot change mid-session). */
export interface SessionLaunchConfig {
  readonly cwd: string
  readonly model: string
  readonly systemPrompt: string
  readonly mcpConfigPaths: readonly string[]
  readonly disallowedTools?: readonly string[]
  readonly maxTurns?: number
  /** If set, the session starts with `--resume <id>` so context survives a cold
   *  start (after idle-sweep / bot restart). Ignored once a warm session exists. */
  readonly resumeSessionId?: string
  /** Called when the session backend stops (cleans generated MCP config, etc.). */
  readonly cleanup?: () => void
}

/** Streamed back from the backend during a turn. */
export type SessionEvent =
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'tool-use'; readonly toolName: string }
  | { readonly kind: 'result'; readonly result: AIResult }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Transport-agnostic persistent session. Implemented per phase.
 * NOTE: there is intentionally NO steer() — stream-json serializes turns,
 * so "steer" is implemented one layer up as interrupt() + next turn.
 */
export interface SessionBackend {
  start(cfg: SessionLaunchConfig): Promise<void>
  /** Run one user turn. Resolves when the turn produces a result or errors. */
  send(text: string, onEvent: (e: SessionEvent) => void): Promise<void>
  /** Stop the current turn; the session stays alive for the next send(). */
  interrupt(): Promise<void>
  /** Tear the whole session down. */
  stop(): Promise<void>
  /** True while a send() turn is in flight. */
  isBusy(): boolean
}
