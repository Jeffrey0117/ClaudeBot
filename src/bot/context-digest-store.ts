/**
 * Context Digest Store
 *
 * Stores structured [CTX] digests that Claude generates at the end of
 * each response. Used to inject precise context when the user sends
 * a short or affirmative reply ("對", "好", "OK").
 *
 * Falls back to raw response tail when no digest is available.
 *
 * Persisted to data/context-digest.json so context survives bot restarts.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { env } from '../config/env.js'

export interface ContextDigest {
  readonly status: 'proposal' | 'question' | 'options' | 'done' | 'error' | 'info'
  readonly summary: string
  readonly pending: string
  readonly next: string
  readonly files: readonly string[]
}

interface StoredContext {
  readonly digest: ContextDigest | null
  readonly rawTail: string
}

const BOT_ID = env.BOT_TOKEN.slice(-6)
const STORE_FILE = join(process.cwd(), 'data', 'context-digest.json')

type PersistedData = Record<string, StoredContext>

function loadAll(): PersistedData {
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function loadStore(): Map<string, StoredContext> {
  const all = loadAll()
  const prefix = `${BOT_ID}:`
  const map = new Map<string, StoredContext>()
  for (const [key, ctx] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      map.set(key.slice(prefix.length), ctx)
    }
  }
  return map
}

function persistStore(): void {
  const all = loadAll()
  const prefix = `${BOT_ID}:`
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) delete all[key]
  }
  for (const [key, ctx] of store) {
    all[`${prefix}${key}`] = ctx
  }
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true })
    const tmp = `${STORE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, STORE_FILE)
  } catch (err) {
    console.error('[context-digest] failed to persist:', err)
  }
}

const store = loadStore()

const MAX_RAW_LENGTH = 1500
// Match [CTX]...[/CTX] or CTX.../CTX (Claude sometimes drops brackets)
// Requires status: line inside to avoid false positives
const CTX_REGEX = /\n?\[?CTX\]?\s*\n(status:[\s\S]*?)\n\s*\[?\/CTX\]?\s*$/

const VALID_STATUSES = new Set(['proposal', 'question', 'options', 'done', 'error', 'info'])

/**
 * Parse a [CTX] block from Claude's response.
 * Returns the digest and the response text with [CTX] stripped.
 */
export function extractDigest(text: string): { digest: ContextDigest | null; cleaned: string } {
  const match = text.match(CTX_REGEX)
  if (!match) {
    return { digest: null, cleaned: text }
  }

  const block = match[1]
  const statusMatch = block.match(/^status:\s*(.+)/m)
  const summaryMatch = block.match(/^summary:\s*(.+)/m)
  const pendingMatch = block.match(/^pending:\s*(.+)/m)
  const nextMatch = block.match(/^next:\s*(.+)/m)
  const filesMatch = block.match(/^files:\s*(.+)/m)

  const status = statusMatch?.[1].trim() as ContextDigest['status'] | undefined
  const summary = summaryMatch?.[1].trim() ?? ''
  const pending = pendingMatch?.[1].trim() ?? 'none'
  const next = nextMatch?.[1].trim() ?? 'none'
  const files = filesMatch
    ? filesMatch[1].trim().split(/[,，]\s*/).filter(Boolean)
    : []

  const digest: ContextDigest | null = status && VALID_STATUSES.has(status)
    ? { status, summary, pending, next, files }
    : null

  // Strip the [CTX] block from the response
  const cleaned = text.replace(CTX_REGEX, '').trimEnd()

  return { digest, cleaned }
}

/** Store context for a project path. */
export function setContext(projectPath: string, fullText: string, digest: ContextDigest | null): void {
  store.set(projectPath, {
    digest,
    rawTail: fullText.slice(-MAX_RAW_LENGTH),
  })
  persistStore()
}

/** Get stored context for a project path. */
export function getContext(projectPath: string): StoredContext | null {
  return store.get(projectPath) ?? null
}

/** Clear stored context. */
export function clearContext(projectPath: string): void {
  store.delete(projectPath)
  persistStore()
}

/**
 * Build the context injection string for a short/affirmative reply.
 * Uses digest if available, falls back to raw tail.
 */
export function buildContextInjection(projectPath: string, isAffirmative: boolean): string | null {
  const ctx = store.get(projectPath)
  if (!ctx) return null

  // Prefer structured digest
  if (ctx.digest) {
    const actionHint = buildActionHint(ctx.digest, isAffirmative)
    const lines = [
      `[前次對話摘要]`,
      `狀態: ${ctx.digest.status}`,
      `摘要: ${ctx.digest.summary}`,
      `待決: ${ctx.digest.pending}`,
    ]

    if (ctx.digest.next !== 'none') {
      lines.push(`下一步: ${ctx.digest.next}`)
    }

    if (ctx.digest.files.length > 0) {
      lines.push(`相關檔案: ${ctx.digest.files.join(', ')}`)
    }

    lines.push(actionHint)
    lines.push(`[/前次對話摘要]`)

    return lines.join('\n')
  }

  // Fallback: raw tail with generic hint
  if (ctx.rawTail) {
    const hint = isAffirmative
      ? '使用者的短回覆是在確認/同意你上次提出的內容。請根據上次回覆繼續執行，不要只回「收到」。'
      : '以下是你上次的回覆，使用者的訊息是針對這個內容。'
    return `[前次回覆參考]\n${hint}\n${ctx.rawTail}\n[/前次回覆參考]`
  }

  return null
}

/** Generate a specific action hint based on digest status + reply type. */
function buildActionHint(digest: ContextDigest, isAffirmative: boolean): string {
  if (!isAffirmative) {
    return '指示: 使用者的訊息是針對上述內容。'
  }

  const nextHint = digest.next !== 'none'
    ? `\n具體下一步: ${digest.next}`
    : ''

  switch (digest.status) {
    case 'proposal':
      return `指示: 使用者同意你的提案「${digest.summary}」。請立即開始執行，不要再確認。${nextHint}`
    case 'question':
      return `指示: 使用者肯定回答了你的問題。根據回答繼續處理。${nextHint}`
    case 'options':
      return `指示: 使用者同意你列出的選項/方向。請按照建議執行。${nextHint}`
    case 'done':
      return `指示: 使用者確認了你的完成報告。如有下一步就繼續，沒有就簡短回應。${nextHint}`
    case 'error':
      return `指示: 使用者回應了你報告的錯誤。根據上下文繼續排除問題。${nextHint}`
    case 'info':
      return `指示: 使用者回應了你的資訊。繼續對話即可。${nextHint}`
  }
}
