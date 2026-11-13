import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Registry guard.
 *
 * bot.ts used to keep TWO parallel hand-synced lists — handlers and advertised
 * descriptions — and they drifted in both directions. They are now one table
 * (`CORE_COMMAND_TABLE`): a command cannot be advertised without a handler,
 * and leaving `description` off is the only way to hide one.
 *
 * What still needs guarding is the hidden set: adding a handler without
 * advertising it must be a deliberate edit here, or it is a capability Claude
 * never learns it has.
 *
 * This test reads bot.ts as text on purpose — importing bot.ts pulls in the
 * whole bot and its live configuration.
 */

const SRC = readFileSync(resolve('src/bot/bot.ts'), 'utf-8')

function sliceBlock(marker: string): string {
  const i = SRC.indexOf(marker)
  if (i === -1) throw new Error(`marker not found in bot.ts: ${marker}`)
  const j = SRC.indexOf('\n]', i)
  if (j === -1) throw new Error(`end of block not found for: ${marker}`)
  return SRC.slice(i, j)
}

interface Entry {
  readonly command: string
  readonly handler: string
  readonly advertised: boolean
}

const entries: readonly Entry[] = [
  ...sliceBlock('const CORE_COMMAND_TABLE: readonly CoreCommand[] = [').matchAll(
    /\{\s*command:\s*'([^']+)',\s*handler:\s*(\w+)(,\s*description:\s*'[^']+')?\s*\}/g,
  ),
].map((m) => ({ command: m[1], handler: m[2], advertised: m[3] !== undefined }))

const names = entries.map((e) => e.command)

/**
 * Commands that intentionally have a handler but are NOT advertised:
 * auth/lifecycle plumbing and numbered aliases of /last.
 */
const INTENTIONALLY_HIDDEN = [
  'start', 'login', 'logout', 'license',
  'mkdir', 'cd', 'prompt', 'ig',
  'last1', 'last2', 'last3', 'last4', 'last5',
].sort()

describe('bot command registry', () => {
  it('parses the command table out of bot.ts', () => {
    expect(entries.length).toBeGreaterThan(50)
  })

  it('every row of the table was understood (nothing silently skipped)', () => {
    const rows = sliceBlock('const CORE_COMMAND_TABLE: readonly CoreCommand[] = [')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
    expect(entries.length).toBe(rows.length)
  })

  it('there is one list, not two', () => {
    expect(SRC).not.toContain('const coreEntries')
    expect(SRC).toContain('for (const { command, handler } of CORE_COMMAND_TABLE)')
  })

  it('lists no command twice', () => {
    expect([...new Set(names)].length).toBe(names.length)
  })

  it('hidden commands are exactly the intended set', () => {
    const hidden = entries.filter((e) => !e.advertised).map((e) => e.command).sort()
    expect(hidden).toEqual(INTENTIONALLY_HIDDEN)
  })
})
