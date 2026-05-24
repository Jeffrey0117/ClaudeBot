import type { AIRunner, AIRunOptions, AIBackend } from './types.js'
import {
  runClaude,
  isRunning,
  cancelRunning,
  getElapsedMs,
} from '../claude/claude-runner.js'
import type { ClaudeModel } from '../types/index.js'

export const claudeAdapter: AIRunner = {
  backend: 'claude' as AIBackend,

  run(options: AIRunOptions): void {
    runClaude({
      prompt: options.prompt,
      projectPath: options.projectPath,
      projectName: options.projectName,
      model: options.model as ClaudeModel,
      sessionId: options.sessionId,
      imagePaths: options.imagePaths,
      chatId: options.chatId,
      threadId: options.threadId,
      maxTurns: options.maxTurns,
      onTextDelta: options.onTextDelta,
      onToolUse: options.onToolUse,
      onResult: (result) => {
        options.onResult({
          ...result,
          backend: 'claude',
          model: options.model,
        })
      },
      onError: options.onError,
      onStaleRetry: options.onStaleRetry,
    })
  },

  isRunning(projectPath?: string): boolean {
    return isRunning(projectPath)
  },

  cancelRunning(projectPath?: string): boolean {
    return cancelRunning(projectPath)
  },

  getElapsedMs(projectPath: string): number {
    return getElapsedMs(projectPath)
  },
}
