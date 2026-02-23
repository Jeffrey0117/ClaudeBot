import type { AIRunner, AIRunOptions, AIBackend } from './types.js'

export const codexRunner: AIRunner = {
  backend: 'codex' as AIBackend,

  run(options: AIRunOptions): void {
    options.onError('Codex backend not yet available. Use /model to switch to Claude or Gemini.')
  },

  isRunning(): boolean {
    return false
  },

  cancelRunning(): boolean {
    return false
  },

  getElapsedMs(): number {
    return 0
  },
}
