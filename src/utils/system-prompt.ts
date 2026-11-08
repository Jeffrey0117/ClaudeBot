import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

/**
 * A spec file that silently resolves to '' takes a whole subsystem down with
 * it: data/ctx-spec.md was absent, so the model was never told to emit [CTX]
 * blocks, every stored digest was null, and the bot still told the user
 * "已用摘要接續". Say so instead of degrading quietly.
 */
function warnMissingSpec(path: string, what: string): void {
  console.error(
    `[system-prompt] ${path} is missing — ${what} is disabled. ` +
      `Anything depending on it will degrade silently.`,
  )
}

function loadCtxSpec(): string {
  if (ctxSpec !== null) return ctxSpec
  try {
    ctxSpec = readFileSync(CTX_SPEC_PATH, 'utf-8').trim()
  } catch {
    ctxSpec = ''
    warnMissingSpec(CTX_SPEC_PATH, 'the [CTX] continuity digest')
  }
  return ctxSpec
}

function loadSubagentSpec(): string {
  if (subagentSpec !== null) return subagentSpec
  try {
    subagentSpec = readFileSync(SUBAGENT_SPEC_PATH, 'utf-8').trim()
  } catch {
    subagentSpec = ''
    warnMissingSpec(SUBAGENT_SPEC_PATH, "/deep's subagent protocol")
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

  return parts.join('\n\n')
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
