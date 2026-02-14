import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROMPT_PATH = resolve('data/system-prompt.md')

let cached: string | null = null

export function getSystemPrompt(): string {
  if (cached !== null) return cached
  try {
    cached = readFileSync(PROMPT_PATH, 'utf-8').trim()
  } catch {
    cached = ''
  }
  return cached
}

export function reloadSystemPrompt(): string {
  cached = null
  return getSystemPrompt()
}
