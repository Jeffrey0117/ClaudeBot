/**
 * Task Store — the unit of memory is the TASK, not the turn.
 *
 * The [CTX] digest was a per-turn summary stored one-per-project and
 * overwritten every turn, so anything decided three turns ago was gone. This
 * keeps an append-only decision log per task instead: the log grows on disk,
 * while the prompt carries only the current state plus a path. That is the
 * point — context stays bounded no matter how long the task runs.
 *
 * JSON is the source of truth (atomic writes, mtime-invalidated, multi-bot
 * safe); a rendered .md sits beside it so a human can just open it.
 */

import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonFileStore } from '../utils/json-file-store.js'
import { statePath } from '../config/paths.js'
import type { ContextDigest } from './context-digest-store.js'

export interface TaskDecision {
  readonly at: number
  readonly text: string
}

export interface Task {
  readonly id: string
  readonly title: string
  readonly status: 'open' | 'done'
  readonly startedAt: number
  readonly updatedAt: number
  readonly decisions: readonly TaskDecision[]
  readonly open: string
  readonly next: string
  readonly files: readonly string[]
}

type TaskData = Record<string, Task>

const store = createJsonFileStore<TaskData>(statePath('data', 'tasks.json'), () => ({}))

/** Keep the log bounded — the newest decisions are the ones that matter. */
const MAX_DECISIONS = 40
/** How many decisions to put in the prompt. The rest stay on disk. */
const INJECT_DECISIONS = 3

function slug(projectPath: string): string {
  const base = projectPath.replace(/[<>:"/\\|?*]/g, '_').slice(-60)
  return `${base}_${createHash('sha1').update(projectPath).digest('hex').slice(0, 6)}`
}

/** Human-readable mirror of the task, so it can simply be opened. */
export function taskFilePath(projectPath: string): string {
  return statePath('data', 'tasks', `${slug(projectPath)}.md`)
}

function render(task: Task): string {
  const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
  const lines = [
    `# ${task.title}`,
    '',
    `- status: ${task.status}`,
    `- started: ${when(task.startedAt)}`,
    `- updated: ${when(task.updatedAt)}`,
    '',
    '## decisions',
    ...(task.decisions.length > 0
      ? task.decisions.map((d) => `- [${when(d.at)}] ${d.text}`)
      : ['- (none yet)']),
    '',
    '## open',
    task.open || '(none)',
    '',
    '## next',
    task.next || '(none)',
    '',
    '## files',
    ...(task.files.length > 0 ? task.files.map((f) => `- ${f}`) : ['- (none)']),
    '',
  ]
  return lines.join('\n')
}

function persist(projectPath: string, task: Task): void {
  const data = store.load()
  store.save({ ...data, [projectPath]: task })
  try {
    const p = taskFilePath(projectPath)
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, render(task), 'utf-8')
    renameSync(tmp, p)
  } catch {
    // the .md is a convenience mirror — never fail a turn over it
  }
}

export function getTask(projectPath: string): Task | null {
  return store.load()[projectPath] ?? null
}

/**
 * Fold one turn's digest into the task.
 *
 * Opens a new task when there is none or the previous one is already done, so
 * a finished task never accumulates the next one's decisions.
 */
export function recordTurn(projectPath: string, digest: ContextDigest): void {
  const existing = getTask(projectPath)
  const now = Date.now()
  const summary = digest.summary.trim()

  const starting = !existing || existing.status === 'done'
  const base: Task = starting
    ? {
        id: new Date(now).toISOString().replace(/[:.]/g, '-'),
        // First summary doubles as the title; it is the one-line "what is this".
        title: summary || '(untitled task)',
        status: 'open',
        startedAt: now,
        updatedAt: now,
        decisions: [],
        open: '',
        next: '',
        files: [],
      }
    : existing

  const decisions = summary
    ? [...base.decisions, { at: now, text: summary }].slice(-MAX_DECISIONS)
    : base.decisions

  const files = [...new Set([...base.files, ...digest.files])].slice(-40)

  persist(projectPath, {
    ...base,
    status: digest.status === 'done' ? 'done' : 'open',
    updatedAt: now,
    decisions,
    open: digest.pending && digest.pending !== 'none' ? digest.pending : '',
    next: digest.next && digest.next !== 'none' ? digest.next : '',
    files,
  })
}

/**
 * Compact current state for the prompt — bounded regardless of task length.
 * The full decision log stays on disk; the path lets the model read it.
 */
export function buildTaskInjection(projectPath: string): string {
  const task = getTask(projectPath)
  if (!task) return ''

  const parts: string[] = [
    `[\u{76EE}\u{524D}\u{4EFB}\u{52D9}] ${task.title}`,
    `\u{72C0}\u{614B}: ${task.status === 'done' ? '\u{5DF2}\u{5B8C}\u{6210}' : '\u{9032}\u{884C}\u{4E2D}'}`,
  ]

  const recent = task.decisions.slice(-INJECT_DECISIONS)
  if (recent.length > 0) {
    parts.push(
      `\u{5DF2}\u{6C7A}\u{5B9A}（\u{6700}\u{8FD1} ${recent.length} \u{689D}）:\n` +
        recent.map((d) => `- ${d.text}`).join('\n'),
    )
  }
  if (task.open) parts.push(`\u{672A}\u{89E3}\u{6C7A}: ${task.open}`)
  if (task.next) parts.push(`\u{4E0B}\u{4E00}\u{6B65}: ${task.next}`)
  if (task.decisions.length > INJECT_DECISIONS) {
    parts.push(
      `\u{5B8C}\u{6574}\u{6C7A}\u{7B56}\u{7D00}\u{9304}（${task.decisions.length} \u{689D}）: ${taskFilePath(projectPath)}`,
    )
  }
  return parts.join('\n')
}

/** Drop a project's task (e.g. /new — the user is explicitly starting over). */
export function clearTask(projectPath: string): void {
  const data = store.load()
  if (!(projectPath in data)) return
  const next = { ...data }
  delete next[projectPath]
  store.save(next)
}
