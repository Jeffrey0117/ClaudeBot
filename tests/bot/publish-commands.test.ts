import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { isValidCommandName, publishBotCommands } from '../../src/bot/publish-commands.js'

type FakeTelegram = Parameters<typeof publishBotCommands>[0]

describe('isValidCommandName', () => {
  it('accepts what Telegram accepts', () => {
    for (const n of ['projects', 'write_note', 'bv', 'r2', 'a'.repeat(32)]) {
      expect(isValidCommandName(n), n).toBe(true)
    }
  })

  it('rejects what Telegram rejects', () => {
    // the hyphen is what froze the live menu
    for (const n of ['write-note', 'Write', 'wrîte', 'has space', '', 'a'.repeat(33)]) {
      expect(isValidCommandName(n), n).toBe(false)
    }
  })
})

describe('publishBotCommands', () => {
  it('sends only the valid names so one bad plugin cannot blank the menu', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true)
    await publishBotCommands({ setMyCommands } as unknown as FakeTelegram, [
      { command: 'projects', description: 'a' },
      { command: 'write-note', description: 'b' },
      { command: 'vault', description: 'c' },
    ])
    expect(setMyCommands).toHaveBeenCalledTimes(1)
    const sent = setMyCommands.mock.calls[0][0] as { command: string }[]
    expect(sent.map((c) => c.command)).toEqual(['projects', 'vault'])
  })

  it('does not throw when Telegram rejects the payload', async () => {
    const setMyCommands = vi.fn().mockRejectedValue(new Error('400: Bad Request'))
    await expect(
      publishBotCommands({ setMyCommands } as unknown as FakeTelegram, [
        { command: 'projects', description: 'a' },
      ]),
    ).resolves.toBeUndefined()
  })
})

/**
 * Lint-style guard: a plugin shipping an illegal command name used to make
 * Telegram reject the entire setMyCommands payload, freezing the autocomplete
 * menu with no visible error.
 */
describe('plugin command names', () => {
  const pluginsDir = resolve('src/plugins')

  /** Extract the `name:` fields inside each plugin's `commands: [ ... ]` block. */
  function declaredCommandNames(source: string): readonly string[] {
    const start = source.indexOf('commands: [')
    if (start === -1) return []
    let depth = 0
    let end = -1
    for (let i = source.indexOf('[', start); i < source.length; i++) {
      if (source[i] === '[') depth++
      else if (source[i] === ']') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return []
    return [...source.slice(start, end).matchAll(/name:\s*'([^']*)'/g)].map((m) => m[1])
  }

  const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ plugin: e.name, file: join(pluginsDir, e.name, 'index.ts') }))
    .filter((e) => existsSync(e.file))

  it('finds plugin sources to check', () => {
    expect(entries.length).toBeGreaterThan(10)
  })

  it('every declared plugin command name is one Telegram will accept', () => {
    const offenders: string[] = []
    for (const { plugin, file } of entries) {
      for (const name of declaredCommandNames(readFileSync(file, 'utf-8'))) {
        if (!isValidCommandName(name)) offenders.push(`${plugin}: "${name}"`)
      }
    }
    expect(offenders).toEqual([])
  })
})
