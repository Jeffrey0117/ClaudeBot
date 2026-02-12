export type ClaudeModel = 'haiku' | 'sonnet' | 'opus'

export interface ProjectInfo {
  readonly name: string
  readonly path: string
}

export interface UserSession {
  readonly chatId: number
  readonly authenticated: boolean
  readonly selectedProject: ProjectInfo | null
  readonly model: ClaudeModel
}

export interface QueueItem {
  readonly chatId: number
  readonly prompt: string
  readonly project: ProjectInfo
  readonly model: ClaudeModel
  readonly sessionId: string | null
}

export interface ClaudeResult {
  readonly sessionId: string
  readonly costUsd: number
  readonly durationMs: number
  readonly cancelled: boolean
}
