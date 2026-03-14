export type AIBackend = 'claude' | 'gemini' | 'codex' | 'auto'

export interface AIModelSelection {
  readonly backend: AIBackend
  readonly model: string
}

export interface AIRunOptions {
  readonly prompt: string
  readonly projectPath: string
  readonly model: string
  readonly sessionId: string | null
  readonly imagePaths: readonly string[]
  readonly chatId?: number
  readonly threadId?: number
  readonly maxTurns?: number
  readonly yolo?: boolean
  readonly onTextDelta: (text: string, accumulated: string) => void
  readonly onToolUse: (toolName: string) => void
  readonly onResult: (result: AIResult) => void
  readonly onError: (error: string) => void
}

export interface AIResult {
  readonly backend: AIBackend
  readonly model: string
  readonly sessionId: string
  readonly costUsd: number
  readonly durationMs: number
  readonly cancelled: boolean
  readonly resultText: string
}

export interface AIRunner {
  readonly backend: AIBackend
  run(options: AIRunOptions): void
  isRunning(projectPath?: string): boolean
  cancelRunning(projectPath?: string): boolean
  getElapsedMs(projectPath: string): number
}

export function resolveBackend(backend: AIBackend): AIBackend {
  return backend === 'auto' ? 'claude' : backend
}

export function formatAILabel(selection: AIModelSelection): string {
  if (selection.backend === 'auto') return 'auto'
  return `${selection.backend}/${selection.model}`
}
