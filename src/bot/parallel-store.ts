/**
 * In-memory store for parallel job state.
 * Tracks pending (awaiting confirmation) and active (running) jobs.
 * No persistence needed — parallel jobs are ephemeral.
 */

import { normalize, resolve } from 'node:path'
import type { AIModelSelection, ProjectInfo } from '../types/index.js'

export interface ParallelTask {
  readonly description: string
  readonly branch: string
  readonly worktreePath: string
  readonly status: 'pending' | 'running' | 'completed' | 'error'
  readonly error?: string
}

export interface ParallelJob {
  readonly id: string
  readonly chatId: number
  readonly projectPath: string
  readonly projectName: string
  readonly project: ProjectInfo
  readonly tasks: readonly ParallelTask[]
  readonly ai: AIModelSelection
  readonly startedAt: number
  readonly statusMessageId?: number
  readonly phase: 'confirming' | 'running' | 'merging' | 'done'
}

/** Pending TTL: 5 minutes for user to confirm */
const PENDING_TTL_MS = 5 * 60 * 1000

/** Stale job TTL: 2 hours — auto-cleanup */
const STALE_TTL_MS = 2 * 60 * 60 * 1000

const pendingJobs = new Map<number, { readonly job: ParallelJob; readonly expiresAt: number }>()
const activeJobs = new Map<number, ParallelJob>()

/** Normalize a path for comparison (case-insensitive on Windows). */
function normPath(p: string): string {
  return normalize(resolve(p)).toLowerCase()
}

export function setPendingJob(chatId: number, job: ParallelJob): void {
  pendingJobs.set(chatId, {
    job,
    expiresAt: Date.now() + PENDING_TTL_MS,
  })
}

export function getPendingJob(chatId: number): ParallelJob | null {
  const entry = pendingJobs.get(chatId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    pendingJobs.delete(chatId)
    return null
  }
  return entry.job
}

export function clearPendingJob(chatId: number): void {
  pendingJobs.delete(chatId)
}

export function setActiveJob(chatId: number, job: ParallelJob): void {
  activeJobs.set(chatId, job)
}

export function getActiveJob(chatId: number): ParallelJob | null {
  return activeJobs.get(chatId) ?? null
}

export function clearActiveJob(chatId: number): void {
  activeJobs.delete(chatId)
}

/** Get all active jobs (for completion hook iteration). */
export function getAllActiveJobs(): ReadonlyMap<number, ParallelJob> {
  return activeJobs
}

/**
 * Mark a task as completed by its worktree path (immutable update).
 * Returns true if all tasks in the job are now done.
 */
export function markTaskCompleted(
  chatId: number,
  worktreePath: string,
): boolean {
  const job = activeJobs.get(chatId)
  if (!job) return false

  const target = normPath(worktreePath)
  const updatedTasks = job.tasks.map((t) =>
    normPath(t.worktreePath) === target && t.status === 'running'
      ? { ...t, status: 'completed' as const }
      : t,
  )

  activeJobs.set(chatId, { ...job, tasks: updatedTasks })
  return isJobDone(chatId)
}

/**
 * Mark a task as errored by its worktree path (immutable update).
 * Returns true if all tasks in the job are now done (completed or errored).
 */
export function markTaskError(
  chatId: number,
  worktreePath: string,
  error: string,
): boolean {
  const job = activeJobs.get(chatId)
  if (!job) return false

  const target = normPath(worktreePath)
  const updatedTasks = job.tasks.map((t) =>
    normPath(t.worktreePath) === target && t.status === 'running'
      ? { ...t, status: 'error' as const, error }
      : t,
  )

  activeJobs.set(chatId, { ...job, tasks: updatedTasks })
  return isJobDone(chatId)
}

/** Check if all tasks in a job are finished (completed or error). */
export function isJobDone(chatId: number): boolean {
  const job = activeJobs.get(chatId)
  if (!job) return true
  return job.tasks.every(
    (t) => t.status === 'completed' || t.status === 'error',
  )
}

/** Get progress summary: "2/3 completed" */
export function getJobProgress(chatId: number): string {
  const job = activeJobs.get(chatId)
  if (!job) return '0/0'
  const done = job.tasks.filter(
    (t) => t.status === 'completed' || t.status === 'error',
  ).length
  return `${done}/${job.tasks.length}`
}

/** Find which chatId owns a given worktree path (for completion hook). */
export function findChatIdByWorktree(worktreePath: string): number | null {
  const target = normPath(worktreePath)
  for (const [chatId, job] of activeJobs) {
    if (job.tasks.some((t) => normPath(t.worktreePath) === target)) {
      return chatId
    }
  }
  return null
}

/** Periodic cleanup: remove stale active jobs (e.g. after bot crash). */
export function cleanupStaleJobs(): void {
  const now = Date.now()
  for (const [chatId, job] of activeJobs) {
    if (now - job.startedAt > STALE_TTL_MS) {
      console.error(`[parallel] cleaning up stale job for chat ${chatId} (age: ${Math.round((now - job.startedAt) / 60_000)}min)`)
      activeJobs.delete(chatId)
    }
  }
}
