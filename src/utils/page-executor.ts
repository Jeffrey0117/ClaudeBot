/**
 * @page directive: publish a generated HTML file and send the user its URL.
 *
 * Format:  @page(path|title)
 * Example: @page(btc-report.html|比特幣近況)
 *
 * The path may be inside the project or the OS temp folder, so a page about
 * Bitcoin doesn't have to leave a stray file in whatever repo is selected.
 */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, resolve } from 'node:path'
import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import {
  MAX_PAGE_BYTES,
  defaultPagesDir,
  getIndexToken,
  isAllowedPageSource,
  normalizePublicBase,
  savePage,
} from '../pages/page-store.js'

export interface PageDirective {
  readonly type: 'page'
  readonly path: string
  readonly title: string
  readonly raw: string
}

export interface PublishOptions {
  readonly projectPath: string
  readonly publicBase: string
  readonly pagesDir?: string
  readonly extraRoots?: readonly string[]
}

export interface PublishedPage {
  readonly url: string
  readonly overviewUrl: string
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const PAGE_PATTERN = /^[ \t]*`?@page[（(](.+)[)）]`?\s*$/gm

export function parsePageDirectives(text: string): readonly PageDirective[] {
  const clean = text.replace(CODE_BLOCK_RE, '')
  return [...clean.matchAll(PAGE_PATTERN)].flatMap((match) => {
    const [rawPath, ...titleParts] = match[1].split('|')
    const path = rawPath.trim()
    if (!path) return []
    const title = titleParts.join('|').trim() || basename(path, extname(path))
    return [{ type: 'page' as const, path, title, raw: match[0] }]
  })
}

export function stripPageDirectives(text: string): string {
  return text
    .replace(PAGE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function publishPageDirective(
  directive: PageDirective,
  options: PublishOptions,
): Promise<PublishedPage> {
  const { projectPath, publicBase, pagesDir = defaultPagesDir(), extraRoots = [tmpdir()] } = options
  const filePath = resolve(projectPath, directive.path)

  if (!isAllowedPageSource(filePath, [projectPath, ...extraRoots])) {
    throw new Error(`路徑不允許或不是 .html 檔案: ${directive.path}`)
  }
  if (statSync(filePath).size > MAX_PAGE_BYTES) {
    throw new Error('檔案太大（上限 5MB）')
  }
  if (!publicBase) {
    throw new Error('目前沒有公開網址（relay tunnel 未連上，或未設定 PAGES_PUBLIC_URL）')
  }

  const page = await savePage(pagesDir, await readFile(filePath, 'utf-8'), directive.title)
  const token = await getIndexToken(pagesDir)
  return {
    url: `${publicBase}/p/${page.id}`,
    overviewUrl: `${publicBase}/p/${token}`,
  }
}

async function resolvePublicBase(): Promise<string> {
  // Imported late: the tunnel module pulls in the validated bot env.
  const { getPublicRelayUrl } = await import('../remote/tunnel.js')
  return normalizePublicBase(process.env.PAGES_PUBLIC_URL || getPublicRelayUrl())
}

export async function executePageDirectives(
  directives: readonly PageDirective[],
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath: string,
): Promise<void> {
  const publicBase = await resolvePublicBase()
  for (const directive of directives) {
    try {
      const { url, overviewUrl } = await publishPageDirective(directive, { projectPath, publicBase })
      await telegram.sendMessage(chatId, `🌐 ${directive.title}\n${url}\n\n📚 所有頁面\n${overviewUrl}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[page] @page(${directive.path}) failed:`, message)
      telegram.sendMessage(chatId, `⚠️ 頁面發布失敗: ${message}`).catch(() => {})
    }
  }
}
