/**
 * In-memory store for active web agent sessions.
 * Follows parallel-store.ts pattern — ephemeral, no persistence.
 * One active agent per chatId. TTL cleanup for stale sessions.
 */

import type { AgentStep } from '../../ai/gemini-agent-vision.js'

/** Stale agent TTL: 5 minutes */
const STALE_TTL_MS = 5 * 60 * 1000

export interface WebAgentJob {
  readonly chatId: number
  readonly url: string
  readonly instruction: string
  readonly abortController: AbortController
  readonly startedAt: number
  readonly currentStep: number
  readonly statusMessageId: number
}

const activeAgents = new Map<number, WebAgentJob>()

export function setActiveAgent(chatId: number, job: WebAgentJob): void {
  activeAgents.set(chatId, job)
}

export function getActiveAgent(chatId: number): WebAgentJob | null {
  return activeAgents.get(chatId) ?? null
}

export function updateAgentStep(chatId: number, step: number): void {
  const job = activeAgents.get(chatId)
  if (!job) return
  activeAgents.set(chatId, { ...job, currentStep: step })
}

export function cancelActiveAgent(chatId: number): boolean {
  const job = activeAgents.get(chatId)
  if (!job) return false
  job.abortController.abort()
  activeAgents.delete(chatId)
  return true
}

export function clearActiveAgent(chatId: number): void {
  activeAgents.delete(chatId)
}

/** Periodic cleanup: remove stale agents (e.g. after crash). */
export function cleanupStaleAgents(): void {
  const now = Date.now()
  for (const [chatId, job] of activeAgents) {
    if (now - job.startedAt > STALE_TTL_MS) {
      job.abortController.abort()
      activeAgents.delete(chatId)
    }
  }
}

// --- Last result cache (for /bv save) ---

export interface LastAgentResult {
  readonly url: string
  readonly instruction: string
  readonly steps: readonly AgentStep[]
  readonly success: boolean
  readonly timestamp: number
}

/** Last 5 minutes only — stale results are ignored. */
const LAST_RESULT_TTL_MS = 5 * 60 * 1000

const lastResults = new Map<number, LastAgentResult>()

export function setLastResult(chatId: number, data: LastAgentResult): void {
  lastResults.set(chatId, data)
}

export function getLastResult(chatId: number): LastAgentResult | null {
  const result = lastResults.get(chatId)
  if (!result) return null
  if (Date.now() - result.timestamp > LAST_RESULT_TTL_MS) {
    lastResults.delete(chatId)
    return null
  }
  return result
}

export function clearLastResult(chatId: number): void {
  lastResults.delete(chatId)
}
