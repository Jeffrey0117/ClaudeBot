import { getTodos } from '../bot/todo-store.js'
import { formatPinsForPrompt, touchPins } from '../bot/context-pin-store.js'
import { formatRulesForPrompt, touchLearnedRules } from '../bot/learned-rules-store.js'
import { buildContextInjection } from '../bot/context-digest-store.js'
import { buildTaskInjection } from '../bot/task-store.js'

/**
 * Per-turn memory injection, shared by every AI backend.
 *
 * This logic used to live only inside claude-runner, but the default backend
 * for local projects is `channel` — so pins, @learn rules and project todos
 * were stored, confirmed to the user ("📌 已釘選 #3"), and then never put in
 * front of the model on the hot path. Keeping it here means one implementation
 * feeds both runners.
 */

/** Detect affirmative/agreement replies that reference the previous message. */
const AFFIRMATIVE_RE = /^(好|可以|沒問題|沒差|OK|ok|Yes|yes|對|嗯|行|做吧|來吧|就這樣|同意|贊成|go|就醬|開始|動手|沒錯|是的|確定|sure|yep|yeah|做啊|加吧|弄吧|改吧|要|proceed|continue|繼續)/i
const AFFIRMATIVE_EMOJI = /^[👍✅✔️👌🫡💪🤙☑️]+$/u

export function looksAffirmative(text: string): boolean {
  const stripped = text.replace(/^[\[（(【]語音輸入[\]）)】]\s*/i, '').trim()
  if (AFFIRMATIVE_EMOJI.test(stripped)) return true
  return AFFIRMATIVE_RE.test(stripped)
}

export interface MemoryPartsInput {
  /** Store lookup key: a real project path, or `remote:<label>`. */
  readonly contextKey: string
  readonly projectName?: string
  /** Path as shown to the model (remote: prefix already stripped). */
  readonly displayPath?: string
}

/**
 * Todos, pinned context, learned rules and the current-project header.
 * Touches pins/rules so their staleness tracking stays accurate.
 */
export function buildMemoryParts(input: MemoryPartsInput): readonly string[] {
  const { contextKey, projectName, displayPath } = input
  const parts: string[] = []

  const pendingTodos = getTodos(contextKey).filter((t) => !t.done)
  if (pendingTodos.length > 0) {
    const todoLines = pendingTodos.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
    parts.push(`[專案待辦清單]\n${todoLines}`)
  }

  const pinnedContext = formatPinsForPrompt(contextKey)
  if (pinnedContext) {
    touchPins(contextKey)
    parts.push(pinnedContext)
  }

  const rulesContext = formatRulesForPrompt(contextKey)
  if (rulesContext) {
    touchLearnedRules(contextKey)
    parts.push(rulesContext)
  }

  if (projectName) {
    parts.push(`[當前專案: ${projectName}]\n路徑: ${displayPath ?? contextKey}`)
  }

  return parts
}

export interface DigestPartsInput {
  readonly contextKey: string
  readonly prompt: string
  /** True when this turn opens a fresh conversation (nothing to resume). */
  readonly isNewSession: boolean
}

/**
 * The stored [CTX] digest, injected when the model would otherwise be amnesiac:
 *  - a brand-new session (first turn, TTL expiry, restart, stale-session retry)
 *  - a short or affirmative reply, which refers to the previous turn
 */
export function buildDigestParts(input: DigestPartsInput): readonly string[] {
  const { contextKey, prompt, isNewSession } = input
  const affirmative = looksAffirmative(prompt)
  const isShortRef = prompt.length <= 15 || (prompt.length <= 80 && affirmative)
  if (!isNewSession && !isShortRef) return []

  const parts: string[] = []

  // Current task state first: it is bounded (a few decisions, open, next, and
  // a path) no matter how long the task has run, because the full decision log
  // lives on disk. That is what keeps a long task from inflating every prompt.
  const task = buildTaskInjection(contextKey)
  if (task) parts.push(task)

  const injection = buildContextInjection(contextKey, affirmative)
  if (injection) parts.push(injection)

  return parts
}
