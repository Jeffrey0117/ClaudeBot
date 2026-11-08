/**
 * Storage for generated web pages ("web secretary").
 *
 * Each page is <id>.html plus an <id>.json sidecar. There is deliberately no
 * shared manifest: several bot processes publish into the same folder, and one
 * file per page means they can never overwrite each other's entries.
 *
 * Pages have no login, so the random id IS the access control. Nothing may
 * enumerate this folder except the overview, which sits behind its own token.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface PageRecord {
  readonly id: string
  readonly title: string
  readonly createdAt: number
}

export const MAX_PAGE_BYTES = 5 * 1024 * 1024
const ID_RE = /^[a-f0-9]{32}$/
const TOKEN_FILE = '.index-token'
const MAX_TITLE_LENGTH = 120

export function defaultPagesDir(): string {
  return join(process.cwd(), 'data', 'pages')
}

export function isPageId(value: string): boolean {
  return ID_RE.test(value)
}

function newId(): string {
  return randomBytes(16).toString('hex')
}

export async function savePage(
  dir: string,
  html: string,
  title: string,
  createdAt: number = Date.now(),
): Promise<PageRecord> {
  await mkdir(dir, { recursive: true })
  const record: PageRecord = { id: newId(), title: title.slice(0, MAX_TITLE_LENGTH), createdAt }
  await writeFile(join(dir, `${record.id}.html`), html, 'utf-8')
  // Sidecar last: a page only shows up in the overview once it is fully written.
  await writeFile(join(dir, `${record.id}.json`), JSON.stringify(record), 'utf-8')
  return record
}

export async function readPage(dir: string, id: string): Promise<string | null> {
  if (!isPageId(id)) return null
  try {
    return await readFile(join(dir, `${id}.html`), 'utf-8')
  } catch {
    return null
  }
}

async function readRecord(dir: string, id: string): Promise<PageRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8')) as PageRecord
    return parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

export async function listPages(dir: string): Promise<readonly PageRecord[]> {
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter(isPageId)
  const records = await Promise.all(ids.map((id) => readRecord(dir, id)))
  return records
    .filter((r): r is PageRecord => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getIndexToken(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, TOKEN_FILE)
  try {
    // 'wx' fails if it exists, so two bots racing still agree on one token.
    const token = newId()
    await writeFile(file, token, { encoding: 'utf-8', flag: 'wx' })
    return token
  } catch {
    return (await readFile(file, 'utf-8')).trim()
  }
}

/** True only for an existing .html file whose real path is inside a root. */
export function isAllowedPageSource(filePath: string, roots: readonly string[]): boolean {
  if (extname(filePath).toLowerCase() !== '.html' || !existsSync(filePath)) return false
  try {
    const real = realpathSync(resolve(filePath))
    if (!statSync(real).isFile()) return false
    return roots.some((root) => {
      const rel = relative(realpathSync(resolve(root)), real)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  } catch {
    return false
  }
}

/** The relay publishes ws(s):// URLs; pages need the matching http(s):// one. */
export function normalizePublicBase(url: string): string {
  const swapped = url.trim().replace(/^ws(s?):\/\//i, 'http$1://')
  try {
    const parsed = new URL(swapped)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const OVERVIEW_STYLE = `
  body{margin:0 auto;max-width:640px;padding:24px 16px;font:16px/1.5 system-ui,sans-serif;color:#1c1c1e;background:#fff}
  h1{font-size:22px;margin:0 0 16px}
  a{display:block;padding:12px 0;border-bottom:1px solid #e5e5ea;color:inherit;text-decoration:none}
  small{display:block;color:#6e6e73}
  @media (prefers-color-scheme:dark){body{color:#f2f2f7;background:#1c1c1e}a{border-color:#3a3a3c}small{color:#98989d}}
`

export function renderOverview(pages: readonly PageRecord[]): string {
  const items = pages.map((p) => {
    const date = new Date(p.createdAt).toISOString().slice(0, 10)
    return `<a href="/p/${p.id}">${escapeHtml(p.title)}<small>${date}</small></a>`
  })
  const body = items.length > 0 ? items.join('') : '<p>還沒有頁面。</p>'
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>我的頁面</title><style>${OVERVIEW_STYLE}</style></head>`
    + `<body><h1>我的頁面</h1>${body}</body></html>`
}
