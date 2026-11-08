import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  setAvailableCommands,
  reloadSystemPrompt,
} from '../../src/utils/system-prompt.js'

const HEADING = '## Available Bot Commands'

/** Parse the "- /name — desc" entries of the generated command section. */
function generatedCommands(prompt: string): readonly string[] {
  const i = prompt.indexOf(HEADING)
  if (i === -1) return []
  const after = prompt.slice(i + HEADING.length)
  const out: string[] = []
  for (const line of after.split('\n')) {
    const m = line.match(/^-\s*\/(\S+)\s*—/)
    if (m) out.push(m[1])
    else if (line.startsWith('## ')) break
  }
  return out
}

describe('system prompt command list', () => {
  beforeEach(() => {
    setAvailableCommands([])
    reloadSystemPrompt()
  })

  it('ships no hardcoded command list in data/system-prompt.md (the list is generated)', () => {
    const raw = readFileSync(resolve('data/system-prompt.md'), 'utf-8')
    expect(raw).not.toContain(HEADING)
  })

  it('emits the generated command list exactly once', () => {
    setAvailableCommands([
      { command: 'projects', description: '瀏覽與選擇專案' },
      { command: 'sync', description: '同步' },
    ])
    const prompt = reloadSystemPrompt()
    expect(prompt.split(HEADING).length - 1).toBe(1)
  })

  it('advertises exactly the registered commands — no stale extras, nothing missing', () => {
    setAvailableCommands([
      { command: 'igdl', description: 'IG 下載' },
      { command: 'channel', description: '頻道' },
      { command: 'sniff', description: '嗅探' },
    ])
    const prompt = reloadSystemPrompt()
    expect(generatedCommands(prompt)).toEqual(['igdl', 'channel', 'sniff'])
  })

  it('omits the section entirely when no commands are registered', () => {
    const prompt = reloadSystemPrompt()
    expect(prompt).not.toContain(HEADING)
  })
})
