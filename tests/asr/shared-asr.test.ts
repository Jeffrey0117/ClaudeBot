import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  isSecondaryBot,
  startSharedAsrServer,
  requestSharedAsr,
  type AsrResult,
} from '../../src/asr/shared-asr.js'

let server: Server | null = null
let dir = ''

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function wavFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'shared-asr-'))
  const file = join(dir, 'voice.wav')
  writeFileSync(file, 'RIFF')
  return file
}

async function listen(transcribe: (wavPath: string) => Promise<AsrResult>): Promise<number> {
  server = await startSharedAsrServer(0, transcribe)
  return (server.address() as AddressInfo).port
}

describe('isSecondaryBot', () => {
  it('is false for the main bot', () => {
    expect(isSecondaryBot(['node', 'index.ts'])).toBe(false)
    expect(isSecondaryBot(['node', 'index.ts', '--env', '.env'])).toBe(false)
  })

  it('is true for .env.botN instances', () => {
    expect(isSecondaryBot(['node', 'index.ts', '--env', '.env.bot3'])).toBe(true)
  })
})

describe('shared ASR', () => {
  it('lets another process transcribe through the main bot', async () => {
    const seen: string[] = []
    const port = await listen(async (wavPath) => {
      seen.push(wavPath)
      return { success: true, text: '你好', duration: 1.5 }
    })
    const file = wavFile()

    const result = await requestSharedAsr(port, file, 5_000)

    expect(result).toEqual({ success: true, text: '你好', duration: 1.5 })
    expect(seen).toEqual([file])
  })

  it('returns null when the main bot is not listening, so the caller can fall back', async () => {
    const port = await listen(async () => ({ success: true, text: '', duration: 0 }))
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null

    expect(await requestSharedAsr(port, wavFile(), 2_000)).toBeNull()
  })

  it('reports a recogniser failure as a failure, not as "unreachable"', async () => {
    const port = await listen(async () => {
      throw new Error('model exploded')
    })

    const result = await requestSharedAsr(port, wavFile(), 5_000)

    expect(result?.success).toBe(false)
    expect(result?.error).toContain('model exploded')
  })

  it('refuses paths that are not existing absolute .wav files', async () => {
    let called = 0
    const port = await listen(async () => {
      called++
      return { success: true, text: 'x', duration: 0 }
    })
    const file = wavFile()

    for (const bad of ['relative.wav', join(dir, 'missing.wav'), join(dir, '..', 'secrets.txt'), '']) {
      const result = await requestSharedAsr(port, bad, 5_000)
      expect(result?.success, bad).toBe(false)
    }
    expect(called).toBe(0)
    expect((await requestSharedAsr(port, file, 5_000))?.success).toBe(true)
  })

  it('times out as a failure instead of hanging', async () => {
    const port = await listen(() => new Promise<AsrResult>(() => {}))

    const result = await requestSharedAsr(port, wavFile(), 300)

    expect(result?.success).toBe(false)
  })

  it('only listens on loopback', async () => {
    await listen(async () => ({ success: true, text: '', duration: 0 }))
    expect((server!.address() as AddressInfo).address).toBe('127.0.0.1')
  })
})
