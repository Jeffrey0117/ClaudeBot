/**
 * Guard for AI-initiated @cmd() directives.
 *
 * The LLM's response text can contain @cmd(/restart) etc. Prompt-injected
 * web content (/bv, /sniff, browse) flows into that same response, so
 * dangerous commands must NOT auto-execute — they get an inline confirm
 * button instead (cmdrun:/cmdskip: callbacks, 5 min TTL).
 */

import { randomUUID } from 'node:crypto'

/** Commands that mutate the machine, remote machines, repos, or bot lifecycle. */
const DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  // bot lifecycle / repo mutation
  'restart', 'deploy', 'land', 'sync', 'newbot', 'install', 'uninstall', 'reload',
  'mkdir', 'cd', 'login', 'logout', 'license', 'allot', 'claudemd',
  // remote machine control
  'rx', 'rexec', 'ron', 'rpower', 'rkill', 'rpull', 'rwrite', 'rclip',
  'js', 'selfupdate', 'fabric', 'bootstrap', 'pair', 'unpair', 'rpair',
  // social / publishing
  'ig',
])

export interface PendingCmd {
  readonly name: string
  readonly command: string
  readonly chatId: number
  readonly createdAt: number
}

const pending = new Map<string, PendingCmd>()
const TTL_MS = 5 * 60_000

function sweep(): void {
  const now = Date.now()
  for (const [id, cmd] of pending) {
    if (now - cmd.createdAt > TTL_MS) pending.delete(id)
  }
}

export function isDangerousCmd(name: string): boolean {
  return DANGEROUS_COMMANDS.has(name.toLowerCase())
}

/** Store a dangerous @cmd awaiting user confirmation; returns the callback id. */
export function registerPendingCmd(name: string, command: string, chatId: number): string {
  sweep()
  const id = randomUUID().slice(0, 8)
  pending.set(id, { name, command, chatId, createdAt: Date.now() })
  return id
}

/** Consume a pending @cmd. Returns null if expired, unknown, or chatId mismatch. */
export function takePendingCmd(id: string, chatId: number): PendingCmd | null {
  sweep()
  const cmd = pending.get(id)
  if (!cmd || cmd.chatId !== chatId) return null
  pending.delete(id)
  return cmd
}
