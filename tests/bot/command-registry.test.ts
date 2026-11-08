import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Registry-drift guard.
 *
 * bot.ts keeps TWO parallel lists:
 *   - `coreEntries`    — the commands that actually have a handler
 *   - `CORE_COMMANDS`  — the commands advertised to Telegram autocomplete and
 *                        injected into Claude's system prompt
 *
 * They are hand-synced, so they drift. Drift is invisible in both directions:
 * an advertised command with no handler does nothing when tapped, and a handler
 * that is never advertised is a capability Claude never learns it has.
 *
 * This test reads bot.ts as text on purpose — `coreEntries` is function-local and
 * importing bot.ts would construct a live Telegraf bot.
 */

const SRC = readFileSync(resolve('src/bot/bot.ts'), 'utf-8')

function sliceBlock(marker: string): string {
  const i = SRC.indexOf(marker)
  if (i === -1) throw new Error(`marker not found in bot.ts: ${marker}`)
  const j = SRC.indexOf('\n  ]', i)
  if (j === -1) throw new Error(`end of block not found for: ${marker}`)
  return SRC.slice(i, j)
}

const advertised: readonly string[] = [
  ...sliceBlock('export const CORE_COMMANDS = [').matchAll(/\{\s*command:\s*'([^']+)'/g),
].map((m) => m[1])

const handlers: readonly string[] = [
  ...sliceBlock('const coreEntries:').matchAll(/\[\s*'([^']+)'\s*,/g),
].map((m) => m[1])

/**
 * Commands that intentionally have a handler but are NOT advertised:
 * auth/lifecycle plumbing and numbered aliases of /last.
 * Adding a handler without advertising it must be a deliberate edit here.
 */
const INTENTIONALLY_HIDDEN = [
  'start', 'login', 'logout', 'license',
  'mkdir', 'cd', 'prompt', 'ig',
  'last1', 'last2', 'last3', 'last4', 'last5',
].sort()

describe('bot command registry', () => {
  it('parses both registries out of bot.ts', () => {
    expect(handlers.length).toBeGreaterThan(50)
    expect(advertised.length).toBeGreaterThan(50)
  })

  it('every advertised command has a handler (no dead autocomplete entries)', () => {
    const missing = advertised.filter((c) => !handlers.includes(c))
    expect(missing).toEqual([])
  })

  it('advertises no duplicates', () => {
    expect([...new Set(advertised)].length).toBe(advertised.length)
  })

  it('registers no duplicate handlers', () => {
    expect([...new Set(handlers)].length).toBe(handlers.length)
  })

  it('hidden commands are exactly the intended set', () => {
    const hidden = handlers.filter((c) => !advertised.includes(c)).sort()
    expect(hidden).toEqual(INTENTIONALLY_HIDDEN)
  })
})
