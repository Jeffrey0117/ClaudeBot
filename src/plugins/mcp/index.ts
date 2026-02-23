import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// --- Types ---

interface McpServerConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema?: unknown
}

interface ConnectedServer {
  readonly name: string
  readonly client: Client
  readonly transport: StdioClientTransport
  readonly tools: readonly McpTool[]
}

// --- State ---

const servers: Map<string, ConnectedServer> = new Map()

// --- Config ---

function loadConfig(): Readonly<Record<string, McpServerConfig>> {
  const configPath = resolve('data', 'mcp-servers.json')
  if (!existsSync(configPath)) return {}

  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as Record<string, McpServerConfig>
  } catch {
    return {}
  }
}

// --- Connection management ---

async function connectServer(name: string, config: McpServerConfig): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
  })

  const client = new Client({ name: `claudebot-${name}`, version: '1.0.0' })
  await client.connect(transport)

  const { tools: rawTools } = await client.listTools()
  const tools: McpTool[] = rawTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
  }))

  return { name, client, transport, tools }
}

async function ensureConnected(): Promise<void> {
  if (servers.size > 0) return

  const config = loadConfig()
  const entries = Object.entries(config)
  if (entries.length === 0) return

  const results = await Promise.allSettled(
    entries.map(async ([name, cfg]) => {
      const server = await connectServer(name, cfg)
      servers.set(name, server)
      return name
    }),
  )

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[mcp] Connection failed:', r.reason)
    }
  }
}

// --- Find tool across all servers ---

function findTool(toolName: string): { server: ConnectedServer; tool: McpTool } | undefined {
  for (const server of servers.values()) {
    const tool = server.tools.find((t) => t.name === toolName)
    if (tool) return { server, tool }
  }
  return undefined
}

// --- Commands ---

async function mcpListCommand(ctx: BotContext): Promise<void> {
  await ensureConnected()

  if (servers.size === 0) {
    await ctx.reply(
      '⚠️ 未設定 MCP server\n\n' +
      '建立 `data/mcp-servers.json`:\n' +
      '```json\n' +
      '{\n' +
      '  "filesystem": {\n' +
      '    "command": "npx",\n' +
      '    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n' +
      '  }\n' +
      '}\n' +
      '```',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const lines = ['🔌 *MCP Servers*', '']
  for (const server of servers.values()) {
    lines.push(`*${server.name}* (${server.tools.length} tools)`)
    for (const tool of server.tools) {
      lines.push(`  \`${tool.name}\` — ${tool.description.slice(0, 60)}`)
    }
    lines.push('')
  }

  lines.push('用法: `/mcp <tool> [JSON args]`')
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

async function mcpCallCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = text.replace(/^\/mcp\s*/i, '').trim()

  if (!args) {
    return mcpListCommand(ctx)
  }

  await ensureConnected()

  // Parse: /mcp toolName {optional JSON args}
  const spaceIdx = args.indexOf(' ')
  const toolName = spaceIdx === -1 ? args : args.slice(0, spaceIdx)
  const rawArgs = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim()

  const match = findTool(toolName)
  if (!match) {
    const allTools = [...servers.values()]
      .flatMap((s) => s.tools.map((t) => t.name))
    await ctx.reply(
      `❌ 找不到工具 \`${toolName}\`\n\n可用: ${allTools.join(', ') || '(無)'}`,
      { parse_mode: 'Markdown' },
    )
    return
  }

  let toolArgs: Record<string, unknown> = {}
  if (rawArgs) {
    try {
      toolArgs = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      // Try key=value parsing: /mcp tool path=/foo
      const pairs = rawArgs.split(/\s+/)
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx > 0) {
          toolArgs[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }
  }

  try {
    const result = await match.server.client.callTool({
      name: toolName,
      arguments: toolArgs,
    })

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')

    const output = content.slice(0, 4000) || '(空結果)'
    const truncated = content.length > 4000 ? '\n\n_...已截斷_' : ''

    await ctx.reply(
      `🔧 *${toolName}* @ ${match.server.name}\n\n\`\`\`\n${output}${truncated}\n\`\`\``,
      { parse_mode: 'Markdown' },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ MCP 呼叫失敗: \`${msg}\``, { parse_mode: 'Markdown' })
  }
}

// --- Cleanup ---

async function cleanup(): Promise<void> {
  for (const server of servers.values()) {
    try {
      await server.client.close()
    } catch { /* ignore */ }
  }
  servers.clear()
}

// --- Plugin export ---

const mcpPlugin: Plugin = {
  name: 'mcp',
  description: 'MCP 工具橋接',
  commands: [
    {
      name: 'mcp',
      description: '列出/呼叫 MCP 工具',
      handler: mcpCallCommand,
    },
  ],
  cleanup,
}

export default mcpPlugin
