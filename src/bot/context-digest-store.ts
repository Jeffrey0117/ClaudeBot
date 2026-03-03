/**
 * Context Digest Store
 *
 * Stores structured [CTX] digests that Claude generates at the end of
 * each response. Used to inject precise context when the user sends
 * a short or affirmative reply ("對", "好", "OK").
 *
 * Falls back to raw response tail when no digest is available.
 */

export interface ContextDigest {
  readonly status: 'proposal' | 'question' | 'options' | 'report' | 'info'
  readonly summary: string
  readonly pending: string
}

interface StoredContext {
  readonly digest: ContextDigest | null
  readonly rawTail: string
}

const store = new Map<string, StoredContext>()

const MAX_RAW_LENGTH = 1500
// Match [CTX]...[/CTX] or CTX.../CTX (Claude sometimes drops brackets)
// Requires status: line inside to avoid false positives
const CTX_REGEX = /\n?\[?CTX\]?\s*\n(status:[\s\S]*?)\n\s*\[?\/CTX\]?\s*$/

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

  const status = statusMatch?.[1].trim() as ContextDigest['status'] | undefined
  const summary = summaryMatch?.[1].trim() ?? ''
  const pending = pendingMatch?.[1].trim() ?? 'none'

  const validStatuses = new Set(['proposal', 'question', 'options', 'report', 'info'])
  const digest: ContextDigest | null = status && validStatuses.has(status)
    ? { status, summary, pending }
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
}

/** Get stored context for a project path. */
export function getContext(projectPath: string): StoredContext | null {
  return store.get(projectPath) ?? null
}

/** Clear stored context. */
export function clearContext(projectPath: string): void {
  store.delete(projectPath)
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
    return (
      `[前次對話摘要]\n` +
      `狀態: ${ctx.digest.status}\n` +
      `摘要: ${ctx.digest.summary}\n` +
      `待決: ${ctx.digest.pending}\n` +
      `${actionHint}\n` +
      `[/前次對話摘要]`
    )
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

  switch (digest.status) {
    case 'proposal':
      return `指示: 使用者同意你的提案「${digest.summary}」。請立即開始執行，不要再確認。`
    case 'question':
      return `指示: 使用者肯定回答了你的問題。根據回答繼續處理。`
    case 'options':
      return `指示: 使用者同意你列出的選項/方向。請按照建議執行。`
    case 'report':
      return `指示: 使用者確認了你的報告。如有下一步就繼續，沒有就簡短回應。`
    case 'info':
      return `指示: 使用者回應了你的資訊。繼續對話即可。`
  }
}
