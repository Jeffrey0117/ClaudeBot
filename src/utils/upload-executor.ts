/**
 * @upload directive executor.
 *
 * Routes uploads by file type:
 *   Images (.jpg/.png/.gif/.webp/.svg/.bmp/.ico) → upimg (public CDN)
 *   Everything else → pokkit (self-hosted storage)
 *
 * Format:  @upload(path)
 * Example: @upload(logo.png)   → upimg
 *          @upload(report.pdf)  → pokkit
 *
 * Path is resolved relative to the current project directory.
 * Results are sent as separate Telegram messages; the directive is
 * stripped from the displayed response text.
 */

import { readFileSync } from 'node:fs'
import { resolve, basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { loadPipeConfig, type PipeConfig } from './pipe-executor.js'

// --- Types ---

export interface UploadDirective {
  readonly type: 'upload'
  readonly path: string
  readonly raw: string
}

// --- Pattern ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const UPLOAD_PATTERN = /^[ \t]*`?@upload[（(](.+)[)）]`?\s*$/gm

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'])

// --- Parser ---

export function parseUploadDirectives(text: string): readonly UploadDirective[] {
  const clean = text.replace(CODE_BLOCK_RE, '')
  const results: UploadDirective[] = []

  UPLOAD_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = UPLOAD_PATTERN.exec(clean)) !== null) {
    const path = match[1].trim()
    if (path) results.push({ type: 'upload', path, raw: match[0] })
  }

  return results
}

export function stripUploadDirectives(text: string): string {
  return text
    .replace(UPLOAD_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- Uploaders ---

export async function uploadToUpimg(filePath: string, config: PipeConfig): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(filePath)]), basename(filePath))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    const res = await fetch(`${config.baseUrl}/api/upimg/upload`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${config.serviceToken}` },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const data = await res.json() as { url?: string; error?: string }
    if (!res.ok || !data.url) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data.url
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

async function uploadToPokkit(filePath: string, config: PipeConfig): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(filePath)]), basename(filePath))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    const res = await fetch(`${config.baseUrl}/api/pokkit/upload`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${config.serviceToken}` },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const data = await res.json() as { url?: string; directUrl?: string; error?: string }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    const url = data.directUrl || data.url
    if (!url) throw new Error('No URL in response')
    return url
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

// --- Executor ---

export async function executeUploadDirectives(
  directives: readonly UploadDirective[],
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath: string,
): Promise<void> {
  const config = loadPipeConfig()

  for (const d of directives) {
    try {
      if (!config) {
        telegram.sendMessage(chatId, '⚠️ @upload 失敗: CloudPipe 未設定').catch(() => {})
        continue
      }

      const filePath = resolve(projectPath, d.path)

      // Path traversal guard — must stay within project directory
      if (!filePath.startsWith(projectPath)) {
        telegram.sendMessage(chatId, '⚠️ @upload 失敗: 路徑不在專案目錄內').catch(() => {})
        continue
      }

      if (!existsSync(filePath)) {
        telegram.sendMessage(chatId, `⚠️ @upload 失敗: 檔案不存在 \`${d.path}\``, { parse_mode: 'Markdown' }).catch(() => {})
        continue
      }

      const ext = extname(filePath).toLowerCase()
      const isImage = IMAGE_EXTS.has(ext)
      const url = isImage
        ? await uploadToUpimg(filePath, config)
        : await uploadToPokkit(filePath, config)
      const target = isImage ? 'upimg' : 'pokkit'

      await telegram.sendMessage(chatId, `📤 已上傳 (${target}): ${url}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[upload] @upload(${d.path}) failed:`, msg)
      telegram.sendMessage(chatId, `⚠️ @upload 失敗: ${msg}`).catch(() => {})
    }
  }
}
