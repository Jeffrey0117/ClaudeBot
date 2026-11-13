import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Reader for a project's `.repo` file — the repository describing itself
 * (what it is, how to work in it, what it offers). Format: the `.repo` spec.
 *
 * Everything here is best-effort: a missing or malformed file is simply
 * "no description", never an error for the caller.
 */

export interface DotRepoOffer {
  readonly id: string
  readonly how: string
  readonly what: string
}

export interface DotRepoSummary {
  readonly name: string
  readonly what: string
  readonly kind: string
  readonly status: string
  readonly run: string
  readonly test: string
  readonly offers: readonly DotRepoOffer[]
  readonly uses: readonly string[]
}

const text = z.string().catch('')

const offerSchema = z.object({ id: z.string().min(1), how: text, what: text })

const dotRepoSchema = z.object({
  name: text,
  what: z.string().trim().min(1),
  kind: text,
  status: text,
  work: z.object({ run: text, test: text }).partial().catch({}),
  offers: z.array(z.unknown()).catch([]),
  uses: z.array(z.unknown()).catch([]),
})

/** How many offers /repo lists before summarising the rest. */
const MAX_OFFERS_SHOWN = 12
const OFFER_WHAT_MAX = 110

export function readDotRepo(projectPath: string): DotRepoSummary | null {
  if (!projectPath || projectPath.startsWith('remote:')) return null

  let raw: string
  try {
    raw = readFileSync(join(projectPath, '.repo'), 'utf-8')
  } catch {
    return null
  }

  let json: unknown
  try {
    json = JSON.parse(raw.replace(/^﻿/, ''))
  } catch {
    return null
  }

  const parsed = dotRepoSchema.safeParse(json)
  if (!parsed.success) return null

  const { name, what, kind, status, work, offers, uses } = parsed.data
  return {
    name,
    what,
    kind,
    status,
    run: work.run ?? '',
    test: work.test ?? '',
    offers: offers.flatMap((o) => {
      const offer = offerSchema.safeParse(o)
      return offer.success ? [offer.data] : []
    }),
    uses: uses.filter((u): u is string => typeof u === 'string' && u.length > 0),
  }
}

/** Escape for Telegram's legacy Markdown parse mode. */
function escapeMarkdown(s: string): string {
  return s.replace(/([_*`[])/g, '\\$1')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Short block (legacy Markdown) appended to the "project selected" message.
 * Empty string when the project has no `.repo`, so callers can append blindly.
 */
export function formatDotRepoIntro(summary: DotRepoSummary | null): string {
  if (!summary) return ''

  const facts = [
    summary.kind,
    summary.status,
    summary.offers.length > 0 ? `提供 ${summary.offers.length} 項能力` : '',
  ].filter(Boolean)

  const lines = [escapeMarkdown(clip(summary.what, 240))]
  if (facts.length > 0) lines.push(`_${escapeMarkdown(facts.join(' · '))}_`)
  return `\n${lines.join('\n')}\n`
}

/** Full description (HTML parse mode) for the /repo command. */
export function formatDotRepoDetail(projectName: string, summary: DotRepoSummary): string {
  const lines = [`<b>${escapeHtml(summary.name || projectName)}</b>`, escapeHtml(summary.what)]

  const facts = [summary.kind, summary.status].filter(Boolean)
  if (facts.length > 0) lines.push(`<i>${escapeHtml(facts.join(' · '))}</i>`)

  const work = [
    summary.run ? `run: <code>${escapeHtml(summary.run)}</code>` : '',
    summary.test ? `test: <code>${escapeHtml(summary.test)}</code>` : '',
  ].filter(Boolean)
  if (work.length > 0) lines.push('', ...work)

  if (summary.uses.length > 0) lines.push('', `依賴：${escapeHtml(summary.uses.join('、'))}`)

  if (summary.offers.length > 0) {
    lines.push('', `<b>提供 ${summary.offers.length} 項能力</b>`)
    for (const o of summary.offers.slice(0, MAX_OFFERS_SHOWN)) {
      lines.push(`• <code>${escapeHtml(o.id)}</code> (${escapeHtml(o.how)}) ${escapeHtml(clip(o.what, OFFER_WHAT_MAX))}`)
    }
    const rest = summary.offers.length - MAX_OFFERS_SHOWN
    if (rest > 0) lines.push(`…還有 ${rest} 項，用 /x1 &lt;想做的事&gt; 找`)
  }

  return lines.join('\n')
}
