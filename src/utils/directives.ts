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
import { addPin, removePin, updatePin } from '../bot/context-pin-store.js'
import { addLearnedRule } from '../bot/learned-rules-store.js'

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

export interface PinDirective {
  readonly type: 'pin'
  readonly text: string
  readonly raw: string
}

export interface UnpinDirective {
  readonly type: 'unpin'
  readonly index: number
  readonly raw: string
}

export interface PinUpdateDirective {
  readonly type: 'pin_update'
  readonly index: number
  readonly text: string
  readonly raw: string
}

export interface LearnDirective {
  readonly type: 'learn'
  readonly rule: string
  readonly raw: string
}

export type Directive = FileDirective | ConfirmDirective | NotifyDirective | PinDirective | UnpinDirective | PinUpdateDirective | LearnDirective

// --- Patterns ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const FILE_PATTERN = /^[ \t]*`?@file[（(](.+)[)）]`?\s*$/gm
const CONFIRM_PATTERN = /^[ \t]*`?@confirm[（(](.+)[)）]`?\s*$/gm
const NOTIFY_PATTERN = /^[ \t]*`?@notify[（(](.+)[)）]`?\s*$/gm
const PIN_PATTERN = /^[ \t]*`?@pin[（(](.+)[)）]`?\s*$/gm
const UNPIN_PATTERN = /^[ \t]*`?@unpin[（(](\d+)[)）]`?\s*$/gm
const PIN_UPDATE_PATTERN = /^[ \t]*`?@pin_update[（(](\d+)\s*[,，]\s*(.+)[)）]`?\s*$/gm
const LEARN_PATTERN = /^[ \t]*`?@learn[（(](.+)[)）]`?\s*$/gm

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

  // @pin(text)
  PIN_PATTERN.lastIndex = 0
  while ((match = PIN_PATTERN.exec(clean)) !== null) {
    const text = match[1].trim()
    if (text) results.push({ type: 'pin', text, raw: match[0] })
  }

  // @unpin(N)
  UNPIN_PATTERN.lastIndex = 0
  while ((match = UNPIN_PATTERN.exec(clean)) !== null) {
    const index = parseInt(match[1], 10)
    results.push({ type: 'unpin', index, raw: match[0] })
  }

  // @pin_update(N, text)
  PIN_UPDATE_PATTERN.lastIndex = 0
  while ((match = PIN_UPDATE_PATTERN.exec(clean)) !== null) {
    const index = parseInt(match[1], 10)
    const text = match[2].trim()
    if (text) results.push({ type: 'pin_update', index, text, raw: match[0] })
  }

  // @learn(rule)
  LEARN_PATTERN.lastIndex = 0
  while ((match = LEARN_PATTERN.exec(clean)) !== null) {
    const rule = match[1].trim()
    if (rule) results.push({ type: 'learn', rule, raw: match[0] })
  }

  return results
}

// --- Strip ---

const ALL_DIRECTIVE_PATTERN = /^[ \t]*`?@(?:file|confirm|notify|pin|unpin|pin_update|learn)[（(](.+)[)）]`?\s*$/gm

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
        case 'pin':
          await executePin(d, chatId, telegram, projectPath)
          break
        case 'unpin':
          await executeUnpin(d, chatId, telegram, projectPath)
          break
        case 'pin_update':
          await executePinUpdate(d, chatId, telegram, projectPath)
          break
        case 'learn':
          await executeLearn(d, chatId, telegram, projectPath)
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

async function executePin(
  d: PinDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  if (!projectPath) return
  const item = addPin(projectPath, d.text)
  if (item) {
    await telegram.sendMessage(chatId, `📎 AI 自動釘選: ${d.text}`, { disable_notification: true })
  } else {
    await telegram.sendMessage(chatId, `📎 釘選已滿 (上限 10 則)，請先移除舊的`, { disable_notification: true })
  }
}

async function executeUnpin(
  d: UnpinDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  if (!projectPath) return
  // Directive uses 1-based index, store uses 0-based
  const removed = removePin(projectPath, d.index - 1)
  if (removed) {
    await telegram.sendMessage(chatId, `📎 AI 移除釘選 #${d.index}`, { disable_notification: true })
  }
}

async function executePinUpdate(
  d: PinUpdateDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  if (!projectPath) return
  // Directive uses 1-based index, store uses 0-based
  const updated = updatePin(projectPath, d.index - 1, d.text)
  if (updated) {
    await telegram.sendMessage(chatId, `📎 AI 更新釘選 #${d.index}: ${d.text}`, { disable_notification: true })
  }
}

async function executeLearn(
  d: LearnDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
  projectPath?: string,
): Promise<void> {
  if (!projectPath) return
  const result = addLearnedRule(projectPath, d.rule)
  if (result.evicted) {
    await telegram.sendMessage(chatId, `🧠 AI 學習規則: ${d.rule}\n(淘汰舊規則: ${result.evicted})`, { disable_notification: true })
  } else {
    await telegram.sendMessage(chatId, `🧠 AI 學習規則: ${d.rule}`, { disable_notification: true })
  }
}
