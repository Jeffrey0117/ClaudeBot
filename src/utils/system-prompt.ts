import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPluginModule } from '../plugins/loader.js'

const PROMPT_PATH = resolve('data/system-prompt.md')
const CTX_SPEC_PATH = resolve('data/ctx-spec.md')
const SUBAGENT_SPEC_PATH = resolve('data/subagent-spec.md')

let basePrompt: string | null = null
let ctxSpec: string | null = null
let subagentSpec: string | null = null

interface CommandInfo {
  readonly command: string
  readonly description: string
}

let registeredCommands: readonly CommandInfo[] = []

/**
 * Register all available commands (core + plugins) so the system prompt
 * can dynamically tell Claude about them.
 */
export function setAvailableCommands(commands: readonly CommandInfo[]): void {
  registeredCommands = commands
}

function loadBasePrompt(): string {
  if (basePrompt !== null) return basePrompt
  try {
    basePrompt = readFileSync(PROMPT_PATH, 'utf-8').trim()
  } catch {
    basePrompt = ''
  }
  return basePrompt
}

function loadCtxSpec(): string {
  if (ctxSpec !== null) return ctxSpec
  try {
    ctxSpec = readFileSync(CTX_SPEC_PATH, 'utf-8').trim()
  } catch {
    ctxSpec = ''
  }
  return ctxSpec
}

function loadSubagentSpec(): string {
  if (subagentSpec !== null) return subagentSpec
  try {
    subagentSpec = readFileSync(SUBAGENT_SPEC_PATH, 'utf-8').trim()
  } catch {
    subagentSpec = ''
  }
  return subagentSpec
}

export function getSystemPrompt(): string {
  const base = loadBasePrompt()
  const ctx = loadCtxSpec()
  const subagent = loadSubagentSpec()

  const parts: string[] = [base]

  if (registeredCommands.length > 0) {
    const commandLines = registeredCommands
      .map((c) => `- /${c.command} — ${c.description}`)
      .join('\n')
    parts.push(`## Available Bot Commands (for reference)\n${commandLines}`)
  }

  if (ctx) {
    parts.push(ctx)
  }

  if (subagent) {
    parts.push(subagent)
  }

  // Inject available MCP tools so Claude knows what @mcp can call
  const mcpToolList = getMcpToolList()
  if (mcpToolList) {
    parts.push(mcpToolList)
  }

  return parts.join('\n\n')
}

/** Build MCP tool list for system prompt injection. */
function getMcpToolList(): string {
  const mcpMod = getPluginModule('mcp') as
    | { getAllTools?: () => ReadonlyArray<{ name: string; description: string }> }
    | undefined

  if (!mcpMod?.getAllTools) return ''

  const tools = mcpMod.getAllTools()
  if (tools.length === 0) return ''

  const lines = [
    '## MCP Tools（可用 @mcp 指令呼叫）',
    '',
    '你可以用 `@mcp(toolName, {"arg": "value"})` 直接呼叫以下工具：',
    '',
  ]

  for (const t of tools) {
    const desc = t.description ? ` — ${t.description.slice(0, 80)}` : ''
    lines.push(`- \`${t.name}\`${desc}`)
  }

  return lines.join('\n')
}

/** Reload both system prompt and CTX spec from disk. */
export function reloadSystemPrompt(): string {
  basePrompt = null
  ctxSpec = null
  subagentSpec = null
  return getSystemPrompt()
}

/** Reload only the CTX spec from disk. */
export function reloadCtxSpec(): string {
  ctxSpec = null
  return loadCtxSpec()
}

/** Reload only the subagent spec from disk. */
export function reloadSubagentSpec(): string {
  subagentSpec = null
  return loadSubagentSpec()
}

/** Reload all spec files (CTX + subagent) from disk. */
export function reloadAllSpecs(): void {
  ctxSpec = null
  subagentSpec = null
  loadCtxSpec()
  loadSubagentSpec()
}
