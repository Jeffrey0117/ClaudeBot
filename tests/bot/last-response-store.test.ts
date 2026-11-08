import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import {
  setLastResponse,
  getLastResponse,
  getLastResponseFilePath,
  getResponseHistoryDir,
  listResponseFiles,
} from '../../src/bot/last-response-store.js'

const made: string[] = []
function projectPath(tag: string): string {
  const p = `C:/tmp/lrs-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  made.push(p)
  return p
}

afterEach(() => {
  for (const p of made.splice(0)) {
    const dir = getResponseHistoryDir(p)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * There used to be exactly one file per project, overwritten every turn, so
 * "go back to what you said before that" was unanswerable — the earlier reply
 * was gone from disk.
 */
describe('last-response history', () => {
  it('keeps earlier responses, not just the latest', () => {
    const p = projectPath('hist')
    setLastResponse(p, 'FIRST-ANSWER')
    setLastResponse(p, 'SECOND-ANSWER')
    setLastResponse(p, 'THIRD-ANSWER')

    const files = listResponseFiles(p)
    expect(files.length).toBe(3)

    const contents = files.map((f) => readFileSync(f, 'utf-8'))
    expect(contents).toContain('FIRST-ANSWER')
    expect(contents).toContain('SECOND-ANSWER')
    expect(contents).toContain('THIRD-ANSWER')
  })

  it('reports the newest file as the previous response', () => {
    const p = projectPath('newest')
    setLastResponse(p, 'OLDER')
    setLastResponse(p, 'NEWEST')
    expect(readFileSync(getLastResponseFilePath(p), 'utf-8')).toBe('NEWEST')
  })

  it('lists newest first', () => {
    const p = projectPath('order')
    setLastResponse(p, 'A')
    setLastResponse(p, 'B')
    const files = listResponseFiles(p)
    expect(readFileSync(files[0], 'utf-8')).toBe('B')
    expect(readFileSync(files[1], 'utf-8')).toBe('A')
  })

  it('does not overwrite when two turns land in the same millisecond', () => {
    const p = projectPath('samems')
    for (let i = 0; i < 5; i++) setLastResponse(p, `BURST-${i}`)
    const files = listResponseFiles(p)
    expect(files.length).toBe(5)
    const contents = new Set(files.map((f) => readFileSync(f, 'utf-8')))
    expect(contents.size).toBe(5)
  })

  it('prunes to the retention limit', () => {
    const p = projectPath('prune')
    for (let i = 0; i < 25; i++) setLastResponse(p, `turn-${i}`)
    expect(listResponseFiles(p).length).toBe(20)
    // the most recent survives
    expect(readFileSync(getLastResponseFilePath(p), 'utf-8')).toBe('turn-24')
  })

  it('still serves the in-memory tail', () => {
    const p = projectPath('tail')
    setLastResponse(p, 'TAIL-CONTENT')
    expect(getLastResponse(p)).toBe('TAIL-CONTENT')
  })

  it('gives two long paths that share a 100-char prefix separate slots', () => {
    const prefix = 'C:/tmp/' + 'x'.repeat(120)
    const a = `${prefix}/alpha`
    const b = `${prefix}/beta`
    made.push(a, b)
    expect(getResponseHistoryDir(a)).not.toBe(getResponseHistoryDir(b))

    setLastResponse(a, 'FOR-ALPHA')
    setLastResponse(b, 'FOR-BETA')
    expect(readFileSync(getLastResponseFilePath(a), 'utf-8')).toBe('FOR-ALPHA')
    expect(readFileSync(getLastResponseFilePath(b), 'utf-8')).toBe('FOR-BETA')
  })
})
