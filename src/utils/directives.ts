/**
 * AI-initiated directive system.
 *
 * Directives are special patterns Claude can include in responses to
 * trigger bot actions — the "AI acts, not just suggests" philosophy.
 *
 * Supported directives:
 *   @file(path)           — Send a local file to the user
 *   @confirm(question|A|B|C) — Show inline buttons for user selection
 *   @notify(message)      — Send a standalone notification message
 *
 * All directives:
 * - Are stripped from the displayed response text
 * - Are NOT matched inside code blocks (``` ... ```)
 * - Support Chinese brackets （）
 * - Support optional leading whitespace and backtick wrapping
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Input, Markup } from 'telegraf'
import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'

// --- Types ---

export interface FileDirective {
  readonly type: 'file'
  readonly path: string
  readonly raw: string
}

export interface ConfirmDirective {
  readonly type: 'confirm'
  readonly question: string
  readonly options: readonly string[]
  readonly raw: string
}

export interface NotifyDirective {
  readonly type: 'notify'
  readonly message: string
  readonly raw: string
}

export type Directive = FileDirective | ConfirmDirective | NotifyDirective

// --- Patterns ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const FILE_PATTERN = /^[ \t]*`?@file[（(]([^)）]+)[)）]`?\s*$/gm
const CONFIRM_PATTERN = /^[ \t]*`?@confirm[（(]([^)）]+)[)）]`?\s*$/gm
const NOTIFY_PATTERN = /^[ \t]*`?@notify[（(]([^)）]+)[)）]`?\s*$/gm

function withoutCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_RE, '')
}

// --- Parser ---

export function parseDirectives(text: string): readonly Directive[] {
  const clean = withoutCodeBlocks(text)
  const results: Directive[] = []

  // @file(path)
  FILE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_PATTERN.exec(clean)) !== null) {
    const path = match[1].trim()
    if (path) results.push({ type: 'file', path, raw: match[0] })
  }

  // @confirm(question|A|B|C)
  CONFIRM_PATTERN.lastIndex = 0
  while ((match = CONFIRM_PATTERN.exec(clean)) !== null) {
    const parts = match[1].split('|').map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const [question, ...options] = parts
      results.push({ type: 'confirm', question, options, raw: match[0] })
    }
  }

  // @notify(message)
  NOTIFY_PATTERN.lastIndex = 0
  while ((match = NOTIFY_PATTERN.exec(clean)) !== null) {
    const message = match[1].trim()
    if (message) results.push({ type: 'notify', message, raw: match[0] })
  }

  return results
}

// --- Strip ---

const ALL_DIRECTIVE_PATTERN = /^[ \t]*`?@(?:file|confirm|notify)[（(]([^)）]+)[)）]`?\s*$/gm

export function stripDirectives(text: string): string {
  return text
    .replace(ALL_DIRECTIVE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- Executor ---

export async function executeDirectives(
  directives: readonly Directive[],
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  for (const d of directives) {
    try {
      switch (d.type) {
        case 'file':
          await executeFile(d, chatId, telegram, projectPath)
          break
        case 'confirm':
          await executeConfirm(d, chatId, telegram)
          break
        case 'notify':
          await executeNotify(d, chatId, telegram)
          break
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[directive] @${d.type} failed:`, msg)
      telegram.sendMessage(chatId, `⚠️ @${d.type} 失敗: ${msg}`).catch(() => {})
    }
  }
}

// --- Handlers ---

async function executeFile(
  d: FileDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  // Resolve relative paths against project dir
  const filePath = projectPath ? resolve(projectPath, d.path) : d.path

  if (!existsSync(filePath)) {
    telegram.sendMessage(chatId, `⚠️ 檔案不存在: \`${d.path}\``, { parse_mode: 'Markdown' }).catch(() => {})
    return
  }

  const fileName = d.path.split(/[\\/]/).pop() || d.path
  await telegram.sendDocument(chatId, Input.fromLocalFile(filePath), {
    caption: `📎 ${fileName}`,
  })
}

async function executeConfirm(
  d: ConfirmDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  const buttons = d.options.map((opt, i) => [
    Markup.button.callback(opt, `confirm_directive:${i}:${opt}`),
  ])
  const keyboard = Markup.inlineKeyboard(buttons)

  await telegram.sendMessage(chatId, `❓ ${d.question}`, {
    parse_mode: 'Markdown',
    ...keyboard,
  })
}

async function executeNotify(
  d: NotifyDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  await telegram.sendMessage(chatId, `🔔 ${d.message}`)
}
