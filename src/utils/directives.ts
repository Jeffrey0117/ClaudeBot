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
 *   @pipe(tool, params)   — Call CloudPipe gateway tool
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
import { callCloudPipeTool } from './cloudpipe.js'

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

export interface PipeDirective {
  readonly type: 'pipe'
  readonly tool: string
  readonly params: Record<string, unknown>
  readonly raw: string
}

export interface PipelineDirective {
  readonly type: 'pipeline'
  readonly steps: ReadonlyArray<{ tool: string; params: Record<string, unknown> }>
  readonly raw: string
}

export type Directive = FileDirective | ConfirmDirective | NotifyDirective | PipeDirective | PipelineDirective

// --- Patterns ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const FILE_PATTERN = /^[ \t]*`?@file[（(]([^)）]+)[)）]`?\s*$/gm
const CONFIRM_PATTERN = /^[ \t]*`?@confirm[（(]([^)）]+)[)）]`?\s*$/gm
const NOTIFY_PATTERN = /^[ \t]*`?@notify[（(]([^)）]+)[)）]`?\s*$/gm
const PIPE_PATTERN = /^[ \t]*`?@pipe[（(]([^)）]+)[)）]`?\s*$/gm
const PIPELINE_PATTERN = /^[ \t]*`?@pipeline[（(]([^)）]+)[)）]`?\s*$/gm

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

  // @pipe(tool, params)
  PIPE_PATTERN.lastIndex = 0
  while ((match = PIPE_PATTERN.exec(clean)) !== null) {
    const content = match[1].trim()
    const parsed = parsePipeArgs(content)
    if (parsed) {
      results.push({ type: 'pipe', tool: parsed.tool, params: parsed.params, raw: match[0] })
    }
  }

  // @pipeline(tool1|tool2|tool3, key=value)
  PIPELINE_PATTERN.lastIndex = 0
  while ((match = PIPELINE_PATTERN.exec(clean)) !== null) {
    const content = match[1].trim()
    const parsed = parsePipelineArgs(content)
    if (parsed) {
      results.push({ type: 'pipeline', steps: parsed, raw: match[0] })
    }
  }

  return results
}

/**
 * Parse @pipe arguments: "tool, key=value, key=value"
 * Examples:
 *   repic_remove_background, url=https://...
 *   monitor.status
 */
function parsePipeArgs(content: string): { tool: string; params: Record<string, unknown> } | null {
  const parts = content.split(',').map((s) => s.trim())
  if (parts.length === 0) return null

  const tool = parts[0]
  if (!tool) return null

  const params: Record<string, unknown> = {}
  for (let i = 1; i < parts.length; i++) {
    const kv = parts[i].split('=')
    if (kv.length === 2) {
      const key = kv[0].trim()
      const value = kv[1].trim()
      // Try to parse JSON values (numbers, booleans, objects)
      try {
        params[key] = JSON.parse(value)
      } catch {
        // Fallback to string
        params[key] = value
      }
    }
  }

  return { tool, params }
}

/**
 * Parse @pipeline arguments: "tool1|tool2|tool3, key=value"
 * Examples:
 *   @pipeline(repic_remove_background|repic_upscale, url=https://...)
 *   @pipeline(step1|step2|step3)
 */
function parsePipelineArgs(content: string): Array<{ tool: string; params: Record<string, unknown> }> | null {
  // Split by first comma to separate tools from params
  const commaIdx = content.indexOf(',')
  const toolsPart = commaIdx === -1 ? content : content.slice(0, commaIdx)
  const paramsPart = commaIdx === -1 ? '' : content.slice(commaIdx + 1)

  const tools = toolsPart.split('|').map(s => s.trim()).filter(Boolean)
  if (tools.length === 0) return null

  // Parse common params
  const params: Record<string, unknown> = {}
  if (paramsPart) {
    const pairs = paramsPart.split(',').map(s => s.trim())
    for (const pair of pairs) {
      const kv = pair.split('=')
      if (kv.length === 2) {
        const key = kv[0].trim()
        const value = kv[1].trim()
        try {
          params[key] = JSON.parse(value)
        } catch {
          params[key] = value
        }
      }
    }
  }

  // Build steps with params
  return tools.map(tool => ({ tool, params }))
}

// --- Strip ---

const ALL_DIRECTIVE_PATTERN = /^[ \t]*`?@(?:file|confirm|notify|pipe|pipeline)[（(]([^)）]+)[)）]`?\s*$/gm

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
        case 'pipe':
          await executePipe(d, chatId, telegram)
          break
        case 'pipeline':
          await executePipeline(d, chatId, telegram)
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

async function executePipe(
  d: PipeDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  // Call CloudPipe gateway
  const result = await callCloudPipeTool(d.tool, d.params)

  if (!result.ok) {
    const errorMsg = result.error || 'Unknown error'
    telegram
      .sendMessage(chatId, `⚠️ CloudPipe call failed: \`${d.tool}\`\n${errorMsg}`, {
        parse_mode: 'Markdown',
      })
      .catch(() => {})
    return
  }

  // Handle result based on type
  const data = result.data

  // If result contains a base64 image (repic_remove_background)
  if (isImageResult(data)) {
    const base64Data = extractBase64(data)
    if (base64Data) {
      const buffer = Buffer.from(base64Data, 'base64')
      await telegram.sendPhoto(chatId, { source: buffer }, { caption: `✅ ${d.tool}` })
      return
    }
  }

  // If result contains a URL
  if (isUrlResult(data)) {
    const url = extractUrl(data)
    if (url) {
      await telegram.sendMessage(chatId, `✅ ${d.tool}\n${url}`)
      return
    }
  }

  // Fallback: send JSON result
  const formatted = JSON.stringify(data, null, 2)
  await telegram.sendMessage(chatId, `✅ ${d.tool}\n\`\`\`json\n${formatted}\n\`\`\``, {
    parse_mode: 'Markdown',
  })
}

// --- Result parsers ---

function isImageResult(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return typeof obj.image === 'string' || typeof obj.data === 'string'
}

function extractBase64(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  // repic returns { image: "data:image/png;base64,..." } or { data: "base64..." }
  if (typeof obj.image === 'string') {
    const match = obj.image.match(/^data:image\/\w+;base64,(.+)$/)
    return match ? match[1] : obj.image
  }

  if (typeof obj.data === 'string') {
    const match = obj.data.match(/^data:image\/\w+;base64,(.+)$/)
    return match ? match[1] : obj.data
  }

  return null
}

function isUrlResult(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return typeof obj.url === 'string'
}

function extractUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>
  return typeof obj.url === 'string' ? obj.url : null
}

async function executePipeline(
  d: PipelineDirective,
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  // Send initial message
  const statusMsg = await telegram.sendMessage(
    chatId,
    `🔄 Pipeline: ${d.steps.map(s => s.tool).join(' → ')}\n\n⏳ 執行中...`,
    { parse_mode: 'Markdown' }
  )

  let currentData: unknown = null
  const results: Array<{ tool: string; ok: boolean; data?: unknown; error?: string }> = []

  // Execute steps sequentially
  for (let i = 0; i < d.steps.length; i++) {
    const step = d.steps[i]
    const isFirst = i === 0
    const isLast = i === d.steps.length - 1

    // Merge previous output into params (if not first step)
    const params = isFirst
      ? step.params
      : { ...step.params, input: currentData }

    // Update status
    await telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      `🔄 Pipeline: ${d.steps.map((s, idx) => idx === i ? `**${s.tool}**` : s.tool).join(' → ')}\n\n⏳ 執行中... (${i + 1}/${d.steps.length})`,
      { parse_mode: 'Markdown' }
    )

    // Call tool
    const result = await callCloudPipeTool(step.tool, params, { useCache: false })

    results.push({
      tool: step.tool,
      ok: result.ok,
      data: result.data,
      error: result.error,
    })

    if (!result.ok) {
      // Pipeline failed
      const summary = results.map((r, idx) => {
        if (r.ok) return `✅ ${r.tool}`
        return `❌ ${r.tool}: ${r.error}`
      }).join('\n')

      await telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        undefined,
        `❌ Pipeline 失敗於步驟 ${i + 1}/${d.steps.length}\n\n${summary}`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // Update current data for next step
    currentData = result.data
  }

  // Success — send final result
  const summary = results.map(r => `✅ ${r.tool}`).join('\n')

  // Handle final result based on type
  if (isImageResult(currentData)) {
    const base64Data = extractBase64(currentData)
    if (base64Data) {
      const buffer = Buffer.from(base64Data, 'base64')
      await telegram.sendPhoto(chatId, { source: buffer }, { caption: `✅ Pipeline 完成\n\n${summary}` })
      await telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
      return
    }
  }

  if (isUrlResult(currentData)) {
    const url = extractUrl(currentData)
    if (url) {
      await telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        undefined,
        `✅ Pipeline 完成\n\n${summary}\n\n${url}`
      )
      return
    }
  }

  // Fallback: JSON result
  const formatted = JSON.stringify(currentData, null, 2)
  let output = `✅ Pipeline 完成\n\n${summary}\n\n\`\`\`json\n${formatted}\n\`\`\``

  if (output.length > 4000) {
    output = output.slice(0, 3900) + '\n\n...(已截斷)'
  }

  await telegram.editMessageText(
    chatId,
    statusMsg.message_id,
    undefined,
    output,
    { parse_mode: 'Markdown' }
  )
}
