/**
 * /parallel — Execute multiple tasks in parallel via git worktrees.
 *
 * Usage:
 *   /parallel
 *   1. 做登入頁面
 *   2. 做資料庫 schema
 *   3. 做 API endpoints
 *
 *   /parallel 任務一 | 任務二 | 任務三
 *   /parallel status
 *   /parallel cancel
 */

import type { Telegram } from 'telegraf'
import type { BotContext } from '../../types/context.js'
import type { ProjectInfo } from '../../types/index.js'
import { getUserState } from '../state.js'
import { env } from '../../config/env.js'
import { isGitRepo, ensureWorktree, mergeToMain, removeWorktree } from '../../git/worktree.js'
import { enqueue, setCompletionHook } from '../../claude/queue.js'
import { Markup } from 'telegraf'
import {
  setPendingJob,
  getPendingJob,
  clearPendingJob,
  setActiveJob,
  getActiveJob,
  clearActiveJob,
  markTaskCompleted,
  isJobDone,
  getJobProgress,
  findChatIdByWorktree,
  cleanupStaleJobs,
} from '../parallel-store.js'
import type { ParallelJob, ParallelTask } from '../parallel-store.js'
import { randomBytes } from 'node:crypto'

/** Telegram API instance — set once at first use, stable across all jobs. */
let telegramApi: Telegram | null = null

/** Whether the global completion hook has been installed. */
let hookInstalled = false

/** Generate a short hex ID for job identification. */
function shortId(): string {
  return randomBytes(4).toString('hex')
}

/** Parse task list from message text (after removing /parallel prefix). */
function parseTasks(text: string): readonly string[] {
  const body = text.replace(/^\/parallel\s*/, '').trim()
  if (!body) return []

  // Pipe-separated: "任務一 | 任務二 | 任務三"
  if (body.includes('|')) {
    return body
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  // Numbered list: "1. 任務一\n2. 任務二"
  const numbered = body
    .split('\n')
    .map((line) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)

  if (numbered.length >= 2) return numbered

  // Dash/bullet list: "- 任務一\n- 任務二"
  const dashed = body
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)

  if (dashed.length >= 2) return dashed

  return []
}

export async function parallelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const body = raw.replace(/^\/parallel\s*/, '').trim()

  // Sub-commands: status, cancel
  if (body === 'status') {
    await showStatus(ctx, chatId)
    return
  }

  if (body === 'cancel') {
    await cancelJob(ctx, chatId)
    return
  }

  // Check prerequisites
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject

  if (!project) {
    await ctx.reply('❌ 請先選擇專案。\n用 /projects 選擇專案。')
    return
  }

  if (!isGitRepo(project.path)) {
    await ctx.reply(`❌ [${project.name}] 不是 Git 專案，無法使用平行模式。`)
    return
  }

  // Check for existing active job
  const existing = getActiveJob(chatId)
  if (existing) {
    await ctx.reply(
      `⚠️ 已有平行任務執行中 (${getJobProgress(chatId)})。\n` +
      '用 `/parallel status` 查看進度，或 `/parallel cancel` 取消。',
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Parse tasks
  const tasks = parseTasks(raw)

  if (tasks.length === 0) {
    await ctx.reply(
      '*用法:*\n' +
      '```\n' +
      '/parallel\n' +
      '1. 做登入頁面\n' +
      '2. 做資料庫 schema\n' +
      '3. 做 API endpoints\n' +
      '```\n\n' +
      '或用 `|` 分隔:\n' +
      '`/parallel 任務一 | 任務二 | 任務三`\n\n' +
      '子指令:\n' +
      '`/parallel status` — 查看進度\n' +
      '`/parallel cancel` — 取消所有',
      { parse_mode: 'Markdown' },
    )
    return
  }

  if (tasks.length < 2) {
    await ctx.reply('❌ 至少需要 2 個任務才能使用平行模式。')
    return
  }

  if (tasks.length > env.MAX_PARALLEL) {
    await ctx.reply(`❌ 最多支援 ${env.MAX_PARALLEL} 個平行任務 (目前 ${tasks.length} 個)。`)
    return
  }

  // Build job
  const jobId = shortId()
  const job: ParallelJob = {
    id: jobId,
    chatId,
    projectPath: project.path,
    projectName: project.name,
    project,
    tasks: tasks.map((desc, i) => ({
      description: desc,
      branch: `parallel-${jobId}-${i + 1}`,
      worktreePath: '',
      status: 'pending' as const,
    })),
    ai: state.ai,
    startedAt: Date.now(),
    phase: 'confirming',
  }

  setPendingJob(chatId, job)

  // Show confirmation
  const taskList = job.tasks
    .map((t, i) => `${i + 1}. ${t.description}`)
    .join('\n')

  await ctx.reply(
    `*平行任務確認*\n\n` +
    `專案: \`${project.name}\`\n` +
    `任務數: ${job.tasks.length}\n\n` +
    `${taskList}\n\n` +
    `每個任務會建立獨立 worktree，完成後自動 merge 回 master。`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ 開跑', 'parallel:confirm'),
          Markup.button.callback('❌ 取消', 'parallel:cancel'),
        ],
      ]),
    },
  )
}

/**
 * Create a parallel job from a smart-detected suggestion.
 * Called when user clicks "⚡ 用平行模式" on a detected multi-task message.
 */
export async function createParallelJobFromSuggestion(
  ctx: BotContext,
  chatId: number,
  tasks: readonly string[],
  threadId: number | undefined,
): Promise<void> {
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject

  if (!project) {
    await ctx.telegram.sendMessage(chatId, '❌ 請先選擇專案。')
    return
  }

  const capped = tasks.slice(0, env.MAX_PARALLEL)
  const jobId = shortId()
  const job: ParallelJob = {
    id: jobId,
    chatId,
    projectPath: project.path,
    projectName: project.name,
    project,
    tasks: capped.map((desc, i) => ({
      description: desc,
      branch: `parallel-${jobId}-${i + 1}`,
      worktreePath: '',
      status: 'pending' as const,
    })),
    ai: state.ai,
    startedAt: Date.now(),
    phase: 'confirming',
  }

  setPendingJob(chatId, job)

  const taskList = job.tasks
    .map((t, i) => `${i + 1}. ${t.description}`)
    .join('\n')

  await ctx.telegram.sendMessage(
    chatId,
    `*平行任務確認*\n\n` +
    `專案: \`${project.name}\`\n` +
    `任務數: ${job.tasks.length}\n\n` +
    `${taskList}\n\n` +
    `每個任務會建立獨立 worktree，完成後自動 merge 回 master。`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ 開跑', 'parallel:confirm'),
          Markup.button.callback('❌ 取消', 'parallel:cancel'),
        ],
      ]),
    },
  )
}

/**
 * Handle parallel callback (confirm/cancel).
 * Called from callback-handler.ts.
 */
export async function handleParallelCallback(
  ctx: BotContext,
  chatId: number,
  data: string,
): Promise<void> {
  if (data === 'parallel:confirm') {
    const job = getPendingJob(chatId)
    if (!job) {
      await ctx.answerCbQuery('任務已過期或不存在')
      return
    }
    clearPendingJob(chatId)

    // Remove buttons
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.answerCbQuery('開始執行！')

    await executeParallelJob(ctx, chatId, job)
  } else if (data === 'parallel:cancel') {
    clearPendingJob(chatId)
    await ctx.editMessageText('❌ 平行任務已取消。')
    await ctx.answerCbQuery('已取消')
  }
}

/**
 * Install the global completion hook (once).
 * Uses stored Telegram API reference so it works across all jobs/users.
 */
function ensureCompletionHook(telegram: Telegram): void {
  telegramApi = telegram

  if (hookInstalled) return
  hookInstalled = true

  // Also start stale job cleanup interval
  setInterval(cleanupStaleJobs, 5 * 60 * 1000)

  setCompletionHook((projectPath: string) => {
    if (!telegramApi) return

    const chatId = findChatIdByWorktree(projectPath)
    if (chatId === null) return

    const job = getActiveJob(chatId)
    if (!job || job.phase !== 'running') return

    const allDone = markTaskCompleted(chatId, projectPath)

    // Re-read job after mutation
    const updatedJob = getActiveJob(chatId)
    if (!updatedJob) return

    // Update progress message
    if (updatedJob.statusMessageId && telegramApi) {
      telegramApi
        .editMessageText(chatId, updatedJob.statusMessageId, undefined, buildStatusMessage(updatedJob))
        .catch(() => {})
    }

    if (allDone && telegramApi) {
      handleAllTasksComplete(telegramApi, chatId, updatedJob)
    }
  })
}

/** Create worktrees and enqueue all tasks. */
async function executeParallelJob(
  ctx: BotContext,
  chatId: number,
  job: ParallelJob,
): Promise<void> {
  // Install global completion hook (idempotent)
  ensureCompletionHook(ctx.telegram)

  // Create worktrees for each task
  const updatedTasks: ParallelTask[] = []

  for (const task of job.tasks) {
    try {
      const wtPath = ensureWorktree(job.projectPath, task.branch)
      updatedTasks.push({
        ...task,
        worktreePath: wtPath,
        status: 'running',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[parallel] worktree creation failed for ${task.branch}:`, msg)
      updatedTasks.push({
        ...task,
        status: 'error',
        error: `Worktree 建立失敗: ${msg.slice(0, 100)}`,
      })
    }
  }

  const activeJob: ParallelJob = {
    ...job,
    tasks: updatedTasks,
    phase: 'running',
  }

  // Send status message first to get message ID
  const statusMsg = await ctx.reply(buildStatusMessage(activeJob))

  // Store job with statusMessageId
  setActiveJob(chatId, { ...activeJob, statusMessageId: statusMsg.message_id })

  // Check if any tasks failed to create worktrees
  const runnableTasks = updatedTasks.filter((t) => t.status === 'running')

  if (runnableTasks.length === 0) {
    await ctx.reply('❌ 所有 worktree 建立失敗，平行任務已取消。')
    clearActiveJob(chatId)
    return
  }

  // Enqueue each runnable task — different projectPath = natural parallelism
  for (const task of runnableTasks) {
    const worktreeProject: ProjectInfo = {
      name: `${job.projectName}/${task.branch}`,
      path: task.worktreePath,
    }

    enqueue({
      chatId,
      prompt: task.description,
      project: worktreeProject,
      ai: job.ai,
      sessionId: null,
      imagePaths: [],
    })
  }
}

/** Build a human-readable status message for a parallel job. */
function buildStatusMessage(job: ParallelJob): string {
  const lines = job.tasks.map((t, i) => {
    const icon =
      t.status === 'completed' ? '✅' :
      t.status === 'error' ? '❌' :
      t.status === 'running' ? '⏳' : '⏸️'
    const errorNote = t.error ? ` — ${t.error.slice(0, 60)}` : ''
    return `${icon} ${i + 1}. ${t.description}${errorNote}`
  })

  const done = job.tasks.filter(
    (t) => t.status === 'completed' || t.status === 'error',
  ).length

  const header =
    job.phase === 'merging' ? '🔀 合併中...' :
    job.phase === 'done' ? '🎉 完成！' :
    `⚡ 平行執行中 (${done}/${job.tasks.length})`

  return `${header}\n\n${lines.join('\n')}`
}

/** All tasks done → merge results back to master. */
async function handleAllTasksComplete(
  telegram: Telegram,
  chatId: number,
  job: ParallelJob,
): Promise<void> {
  const updatedJob: ParallelJob = { ...job, phase: 'merging' }
  setActiveJob(chatId, updatedJob)

  // Update status message
  if (job.statusMessageId) {
    await telegram
      .editMessageText(chatId, job.statusMessageId, undefined, buildStatusMessage(updatedJob))
      .catch(() => {})
  }

  await mergeParallelResults(telegram, chatId, updatedJob)
}

/** Sequentially merge each completed task branch back to master, then clean up. */
async function mergeParallelResults(
  telegram: Telegram,
  chatId: number,
  job: ParallelJob,
): Promise<void> {
  const completedTasks = job.tasks.filter((t) => t.status === 'completed')
  const results: string[] = []
  let hasConflict = false

  // Try merging ALL completed tasks, don't stop at first conflict
  for (const task of completedTasks) {
    const mergeResult = mergeToMain(job.projectPath, task.branch)

    if (mergeResult.success) {
      results.push(`✅ ${task.description}`)
      try {
        removeWorktree(job.projectPath, task.branch, true)
      } catch (error) {
        console.error(`[parallel] worktree cleanup failed for ${task.branch}:`, error)
      }
    } else {
      hasConflict = true
      const conflictFiles = mergeResult.conflicts?.length
        ? `\n   衝突: ${mergeResult.conflicts.join(', ')}`
        : ''
      results.push(`⚠️ ${task.description} — 合併衝突${conflictFiles}`)
      // Keep branch for manual resolution, remove worktree directory
      try {
        removeWorktree(job.projectPath, task.branch, false)
      } catch (error) {
        console.error(`[parallel] worktree cleanup failed for ${task.branch}:`, error)
      }
    }
  }

  // Clean up errored task worktrees
  for (const task of job.tasks.filter((t) => t.status === 'error')) {
    try {
      removeWorktree(job.projectPath, task.branch, true)
    } catch (error) {
      console.error(`[parallel] worktree cleanup failed for ${task.branch}:`, error)
    }
  }

  // Final status
  const finalJob: ParallelJob = { ...job, phase: 'done' }
  setActiveJob(chatId, finalJob)

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000)
  const conflictNote = hasConflict
    ? '\n\n⚠️ 有衝突需要手動解決。衝突分支已保留。'
    : ''

  const summary =
    `🎉 *平行任務完成*\n\n` +
    `專案: \`${job.projectName}\`\n` +
    `耗時: ${elapsed}s\n\n` +
    `${results.join('\n')}${conflictNote}`

  // Update status message
  if (job.statusMessageId) {
    await telegram
      .editMessageText(chatId, job.statusMessageId, undefined, buildStatusMessage(finalJob))
      .catch(() => {})
  }

  await telegram.sendMessage(chatId, summary, { parse_mode: 'Markdown' })
  clearActiveJob(chatId)
}

/** /parallel status — show current progress. */
async function showStatus(ctx: BotContext, chatId: number): Promise<void> {
  const job = getActiveJob(chatId)
  if (!job) {
    const pending = getPendingJob(chatId)
    if (pending) {
      await ctx.reply('⏳ 有待確認的平行任務，請按確認按鈕。')
    } else {
      await ctx.reply('ℹ️ 目前沒有平行任務在執行。')
    }
    return
  }

  await ctx.reply(buildStatusMessage(job))
}

/** /parallel cancel — cancel active or pending job. */
async function cancelJob(ctx: BotContext, chatId: number): Promise<void> {
  // Cancel pending
  const pending = getPendingJob(chatId)
  if (pending) {
    clearPendingJob(chatId)
    await ctx.reply('❌ 待確認的平行任務已取消。')
    return
  }

  // Cancel active
  const job = getActiveJob(chatId)
  if (!job) {
    await ctx.reply('ℹ️ 沒有平行任務可取消。')
    return
  }

  // Clean up worktrees
  for (const task of job.tasks) {
    try {
      removeWorktree(job.projectPath, task.branch, true)
    } catch (error) {
      console.error(`[parallel] cancel cleanup failed for ${task.branch}:`, error)
    }
  }

  clearActiveJob(chatId)
  await ctx.reply('❌ 平行任務已取消，worktree 已清理。')
}
