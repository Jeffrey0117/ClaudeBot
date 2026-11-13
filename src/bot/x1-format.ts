/**
 * Formatting for X1 lookups (CloudPipe gateway `/api/gateway/find`):
 * "what can do this?" answered across every project, without reading any of them.
 */

export interface X1Match {
  readonly id: string
  readonly tool: string
  readonly description: string
  readonly effect: string
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly proven: boolean
  readonly blocked: boolean
  readonly failing: boolean
}

export interface X1Offer {
  readonly id: string
  readonly how: string
  readonly use: string
  readonly what: string
}

export interface X1Project {
  readonly id: string
  readonly capabilities: number
}

export interface X1FindResult {
  readonly matches: readonly X1Match[]
  readonly offers: readonly X1Offer[]
  readonly projects: readonly X1Project[]
}

/** Telegram caps a message at 4096 chars; leave room for the footer. */
const MAX_LENGTH = 4000
const DESCRIPTION_MAX = 160
const MAX_OPTIONAL_PARAMS = 3

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
}

function list<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : []
}

function strings(value: unknown): readonly string[] {
  return list<unknown>(value).filter((v): v is string => typeof v === 'string')
}

function formatMatch(m: X1Match): string {
  const flags = [
    m.proven ? '用過' : '',
    m.blocked ? '沒權限' : '',
    m.failing ? '最近失敗' : '',
    m.effect && m.effect !== 'read' ? '會寫入' : '',
  ].filter(Boolean)

  const params = [
    ...strings(m.required),
    ...strings(m.optional).slice(0, MAX_OPTIONAL_PARAMS).map((p) => `[${p}]`),
  ]

  return [
    `<b>${esc(m.id)}</b>${flags.length > 0 ? `（${flags.join('、')}）` : ''}`,
    esc(String(m.description ?? '').slice(0, DESCRIPTION_MAX)),
    params.length > 0 ? `參數：<code>${esc(params.join(' '))}</code>` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatOffer(o: X1Offer): string {
  return [
    `<b>${esc(o.id)}</b>（${esc(o.how)}，寫程式用）`,
    esc(String(o.what ?? '').slice(0, DESCRIPTION_MAX)),
    o.use ? `<code>${esc(o.use)}</code>` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Render a find result as Telegram HTML. Never throws on a malformed payload. */
export function formatFindResult(task: string, result: X1FindResult | null | undefined): string {
  const matches = list<X1Match>(result?.matches)
  const offers = list<X1Offer>(result?.offers)
  const projects = list<X1Project>(result?.projects)

  if (matches.length === 0 && offers.length === 0 && projects.length === 0) {
    return `找不到跟「${esc(task)}」有關的能力。換個說法再試一次。`
  }

  const blocks = [...matches.map(formatMatch), ...offers.map(formatOffer)]
  const footer =
    projects.length > 0
      ? `相關專案：${projects.map((p) => `${esc(p.id)}（${esc(p.capabilities)}）`).join('、')}`
      : ''

  const kept: string[] = []
  let length = footer.length
  for (const block of blocks) {
    if (length + block.length + 2 > MAX_LENGTH) break
    kept.push(block)
    length += block.length + 2
  }

  return [...kept, footer].filter(Boolean).join('\n\n').slice(0, MAX_LENGTH)
}
