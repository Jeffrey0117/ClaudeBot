/**
 * Best-effort JSONL audit log for remote tool calls.
 * Writes to data/remote-audit.jsonl, keeps last 1000 entries on rotation.
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const LOG_PATH = join(process.cwd(), 'data', 'remote-audit.jsonl')
const MAX_ENTRIES = 1_000

export interface AuditEntry {
  readonly ts: string
  readonly tool: string
  readonly argsPreview: string
  readonly ok: boolean
  readonly durationMs: number
  readonly error?: string
}

export function appendAuditEntry(entry: AuditEntry): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // Best-effort — never crash on write failure
  }
}

export function rotateAuditLog(): void {
  try {
    const raw = readFileSync(LOG_PATH, 'utf-8')
    const lines = raw.trim().split('\n')
    if (lines.length <= MAX_ENTRIES) return
    const kept = lines.slice(-MAX_ENTRIES).join('\n') + '\n'
    writeFileSync(LOG_PATH, kept, 'utf-8')
  } catch {
    // File may not exist yet — ignore
  }
}
