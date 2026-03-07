/**
 * @mcp directive executor.
 *
 * Lets Claude call MCP tools directly from its response text.
 * Uses the MCP plugin's connection pool via getPluginModule('mcp').
 *
 * Format:  @mcp(toolName, {"arg1": "value1"})
 * Examples:
 *   @mcp(ab_open, {"url": "https://example.com"})
 *   @mcp(remote_read_file, {"path": "/etc/hostname"})
 *   @mcp(browse, {"url": "https://example.com"})
 *
 * All @mcp calls are stripped from the displayed text, and results
 * are sent as separate Telegram messages.
 */

import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { splitText } from './text-splitter.js'
import { getPluginModule } from '../plugins/loader.js'

// --- Types ---

export interface McpDirective {
  readonly type: 'mcp'
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly raw: string
}

// --- Pattern ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const MCP_PATTERN = /^[ \t]*`?@mcp[（(]([^)）]+)[)）]`?\s*$/gm

// --- Parser ---

export function parseMcpDirectives(text: string): readonly McpDirective[] {
  const clean = text.replace(CODE_BLOCK_RE, '')
  const results: McpDirective[] = []

  MCP_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MCP_PATTERN.exec(clean)) !== null) {
    const inner = match[1].trim()
    if (!inner) continue

    // Split on first comma: "toolName, {JSON args}" → tool + args
    const commaIdx = inner.indexOf(',')
    const tool = commaIdx === -1 ? inner.trim() : inner.slice(0, commaIdx).trim()
    const rawArgs = commaIdx === -1 ? '' : inner.slice(commaIdx + 1).trim()

    let args: Record<string, unknown> = {}
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>
      } catch {
        // If not valid JSON, try key=value pairs
        const pairs = rawArgs.split(/\s+/)
        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=')
          if (eqIdx > 0) {
            args[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
          }
        }
      }
    }

    results.push({ type: 'mcp', tool, args, raw: match[0] })
  }

  return results
}

export function stripMcpDirectives(text: string): string {
  return text
    .replace(MCP_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- Send helper ---

async function sendSafe(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' })
  } catch {
    await telegram.sendMessage(chatId, text)
  }
}

// --- Executor ---

export async function executeMcpDirectives(
  directives: readonly McpDirective[],
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  const mcpMod = getPluginModule('mcp') as
    | { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }
    | undefined

  for (const d of directives) {
    try {
      if (!mcpMod?.callTool) {
        telegram.sendMessage(chatId, '⚠️ MCP 插件未載入，無法執行 @mcp').catch(() => {})
        continue
      }

      const result = await mcpMod.callTool(d.tool, d.args)
      const output = result.length > 4000
        ? `${result.slice(0, 4000)}\n\n_...已截斷_`
        : result

      const chunks = splitText(`🔧 *${d.tool}*\n\n\`\`\`\n${output}\n\`\`\``)
      for (const chunk of chunks) {
        await sendSafe(telegram, chatId, chunk)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[mcp-executor] @mcp(${d.tool}) failed:`, msg)
      telegram.sendMessage(chatId, `⚠️ @mcp(${d.tool}) 失敗: ${msg}`).catch(() => {})
    }
  }
}
