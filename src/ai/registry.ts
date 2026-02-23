import type { AIRunner, AIBackend } from './types.js'
import { claudeAdapter } from './claude-adapter.js'
import { geminiRunner } from './gemini-runner.js'
import { codexRunner } from './codex-runner.js'

const runners = new Map<AIBackend, AIRunner>()

export function registerRunner(runner: AIRunner): void {
  runners.set(runner.backend, runner)
}

export function getRunner(backend: AIBackend): AIRunner {
  if (backend === 'auto') {
    return claudeAdapter
  }
  const runner = runners.get(backend)
  if (!runner) {
    throw new Error(`No runner registered for backend: ${backend}`)
  }
  return runner
}

export function cancelAnyRunning(projectPath?: string): boolean {
  let cancelled = false
  for (const runner of runners.values()) {
    if (runner.cancelRunning(projectPath)) {
      cancelled = true
    }
  }
  return cancelled
}

export function isAnyRunning(projectPath?: string): boolean {
  for (const runner of runners.values()) {
    if (runner.isRunning(projectPath)) return true
  }
  return false
}

export function getAnyElapsedMs(projectPath: string): number {
  for (const runner of runners.values()) {
    const ms = runner.getElapsedMs(projectPath)
    if (ms > 0) return ms
  }
  return 0
}

// Auto-register all adapters
registerRunner(claudeAdapter)
registerRunner(geminiRunner)
registerRunner(codexRunner)
