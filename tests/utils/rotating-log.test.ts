import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRotatingLog } from '../../src/utils/rotating-log.js'

let dir = ''

function logPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'rotating-log-'))
  return join(dir, 'launcher.log')
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('createRotatingLog', () => {
  it('appends to the log file', () => {
    const file = logPath()
    const log = createRotatingLog({ file, maxBytes: 1000, keep: 3 })
    log.write('one\n')
    log.write('two\n')
    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\n')
  })

  it('continues an existing file instead of truncating it', () => {
    const file = logPath()
    writeFileSync(file, 'old\n')
    createRotatingLog({ file, maxBytes: 1000, keep: 3 }).write('new\n')
    expect(readFileSync(file, 'utf-8')).toBe('old\nnew\n')
  })

  it('moves a full file aside and starts a fresh one', () => {
    const file = logPath()
    const log = createRotatingLog({ file, maxBytes: 20, keep: 3 })
    log.write('a'.repeat(25) + '\n')
    log.write('fresh\n')
    expect(readFileSync(`${file}.1`, 'utf-8')).toBe('a'.repeat(25) + '\n')
    expect(readFileSync(file, 'utf-8')).toBe('fresh\n')
  })

  it('counts an existing oversized file, so a restart does not reset the limit', () => {
    const file = logPath()
    writeFileSync(file, 'x'.repeat(50))
    createRotatingLog({ file, maxBytes: 20, keep: 3 }).write('fresh\n')
    expect(readFileSync(`${file}.1`, 'utf-8')).toBe('x'.repeat(50))
    expect(readFileSync(file, 'utf-8')).toBe('fresh\n')
  })

  it('keeps only the newest N old files', () => {
    const file = logPath()
    const log = createRotatingLog({ file, maxBytes: 5, keep: 2 })
    for (const tag of ['first', 'second', 'third', 'fourth']) log.write(`${tag}-line\n`)
    log.write('now\n')

    expect(readFileSync(file, 'utf-8')).toBe('now\n')
    expect(readFileSync(`${file}.1`, 'utf-8')).toBe('fourth-line\n')
    expect(readFileSync(`${file}.2`, 'utf-8')).toBe('third-line\n')
    expect(existsSync(`${file}.3`)).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['launcher.log', 'launcher.log.1', 'launcher.log.2'])
  })

  it('never throws when the file cannot be written', () => {
    const log = createRotatingLog({ file: join(tmpdir(), 'no-such-dir-xyz', 'deep', 'x.log'), maxBytes: 10, keep: 1 })
    expect(() => log.write('lost\n')).not.toThrow()
  })
})
