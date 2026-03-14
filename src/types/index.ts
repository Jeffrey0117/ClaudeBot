import type { AIModelSelection, AIResult } from '../ai/types.js'

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus'

export type { AIModelSelection, AIResult }
export type { AIBackend } from '../ai/types.js'

export interface ProjectInfo {
  readonly name: string
  readonly path: string
}

export interface UserSession {
  readonly chatId: number
  readonly authenticated: boolean
  readonly selectedProject: ProjectInfo | null
  readonly ai: AIModelSelection
}

export interface QueueItem {
  readonly chatId: number
  readonly threadId?: number
  readonly prompt: string
  readonly project: ProjectInfo
  readonly ai: AIModelSelection
  readonly sessionId: string | null
  readonly imagePaths: readonly string[]
  readonly dashboardCommandId?: string
  readonly maxTurns?: number
  readonly yolo?: boolean
}

export interface ClaudeResult {
  readonly sessionId: string
  readonly costUsd: number
  readonly durationMs: number
  readonly cancelled: boolean
  readonly resultText: string
}
