import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSleepCandidate,
  readBotEnv,
  sleepIdleMsFromEnv,
  startSleeper,
  type FetchLike,
  type SleeperOptions,
} from '../../src/launcher-sleep.js'

const NOW = 1_800_000_000_000
const IDLE = 30 * 60_000

function heartbeat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    updatedAt: NOW - 1_000,
    queueLength: 0,
    activeRunners: [],
    machines: [],
    lastActivityAt: NOW - IDLE - 1,
    ...over,
  }
}

describe('isSleepCandidate', () => {
  it('lets a bot sleep once it has been idle long enough', () => {
    expect(isSleepCandidate(heartbeat(), NOW, IDLE)).toBe(true)
  })

  it('keeps a recently used bot awake', () => {
    expect(isSleepCandidate(heartbeat({ lastActivityAt: NOW - 60_000 }), NOW, IDLE)).toBe(false)
  })

  it('keeps a bot awake while it has queued or running work', () => {
    expect(isSleepCandidate(heartbeat({ queueLength: 1 }), NOW, IDLE)).toBe(false)
    expect(isSleepCandidate(heartbeat({ activeRunners: [{}] }), NOW, IDLE)).toBe(false)
  })

  it('keeps a bot awake while a remote machine is paired to it', () => {
    expect(isSleepCandidate(heartbeat({ machines: [{ label: 'laptop' }] }), NOW, IDLE)).toBe(false)
  })

  it('does not decide on a stale heartbeat or one that does not report activity', () => {
    expect(isSleepCandidate(heartbeat({ updatedAt: NOW - 60_000 }), NOW, IDLE)).toBe(false)
    expect(isSleepCandidate(heartbeat({ lastActivityAt: undefined }), NOW, IDLE)).toBe(false)
    expect(isSleepCandidate(null, NOW, IDLE)).toBe(false)
    expect(isSleepCandidate({ nonsense: true }, NOW, IDLE)).toBe(false)
  })

  it('never sleeps when sleeping is disabled', () => {
    expect(isSleepCandidate(heartbeat(), NOW, 0)).toBe(false)
  })
})

describe('sleepIdleMsFromEnv', () => {
  it('is off unless a positive number of minutes is configured', () => {
    expect(sleepIdleMsFromEnv(undefined)).toBe(0)
    expect(sleepIdleMsFromEnv('')).toBe(0)
    expect(sleepIdleMsFromEnv('0')).toBe(0)
    expect(sleepIdleMsFromEnv('-5')).toBe(0)
    expect(sleepIdleMsFromEnv('abc')).toBe(0)
  })

  it('converts minutes to milliseconds', () => {
    expect(sleepIdleMsFromEnv('30')).toBe(30 * 60_000)
  })
})

describe('readBotEnv', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reads the token and API base of a bot', () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-env-'))
    const file = join(dir, '.env.bot3')
    writeFileSync(file, 'BOT_TOKEN=123:abc\nTELEGRAM_API_BASE=https://proxy.example/\nOTHER=1\n')
    expect(readBotEnv(file)).toEqual({ token: '123:abc', apiBase: 'https://proxy.example' })
  })

  it('defaults to the official API and rejects a file without a token', () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-env-'))
    const ok = join(dir, '.env.bot2')
    writeFileSync(ok, 'BOT_TOKEN=123:abc\n')
    expect(readBotEnv(ok)?.apiBase).toBe('https://api.telegram.org')

    const bad = join(dir, '.env.bot4')
    writeFileSync(bad, 'OTHER=1\n')
    expect(readBotEnv(bad)).toBeNull()
    expect(readBotEnv(join(dir, 'missing'))).toBeNull()
  })
})

describe('startSleeper', () => {
  type Reply = { ok: boolean; result?: unknown[]; error_code?: number } | Error

  function harness(replies: Reply[]) {
    const urls: string[] = []
    const woke: unknown[] = []
    const gaveUp: string[] = []
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })

    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url)
      const next = replies.shift()
      if (next === undefined) {
        // Out of scripted replies: hang like a real long poll until aborted.
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (next instanceof Error) throw next
      return { json: async () => next }
    }

    const options: SleeperOptions = {
      token: '123:secret',
      apiBase: 'https://api.example',
      pollSeconds: 25,
      retryDelayMs: 1,
      maxFailures: 3,
      fetchImpl,
      onWake: (update) => {
        woke.push(update)
        done()
      },
      onGiveUp: (reason) => {
        gaveUp.push(reason)
        done()
      },
    }
    return { options, urls, woke, gaveUp, finished }
  }

  it('wakes the bot when a message is waiting, without consuming it', async () => {
    const update = { update_id: 7, message: { chat: { id: 42 } } }
    const h = harness([{ ok: true, result: [] }, { ok: true, result: [update] }])

    startSleeper(h.options)
    await h.finished

    expect(h.woke).toEqual([update])
    expect(h.gaveUp).toEqual([])
    expect(h.urls).toHaveLength(2)
    // Peeking only: an offset would confirm the update and the bot would never see it.
    for (const url of h.urls) {
      expect(url).toBe('https://api.example/bot123:secret/getUpdates?timeout=25&limit=1')
    }
  })

  it('keeps listening through a temporary failure', async () => {
    const update = { update_id: 1 }
    const h = harness([new Error('network down'), { ok: false, error_code: 409 }, { ok: true, result: [update] }])

    startSleeper(h.options)
    await h.finished

    expect(h.woke).toEqual([update])
    expect(h.gaveUp).toEqual([])
  })

  it('gives up after repeated failures so the caller can start the bot instead', async () => {
    const h = harness([new Error('a'), new Error('b'), new Error('c')])

    startSleeper(h.options)
    await h.finished

    expect(h.woke).toEqual([])
    expect(h.gaveUp).toHaveLength(1)
  })

  it('gives up at once when the token is rejected', async () => {
    const h = harness([{ ok: false, error_code: 401 }])

    startSleeper(h.options)
    await h.finished

    expect(h.gaveUp).toHaveLength(1)
    expect(h.urls).toHaveLength(1)
  })

  it('stops quietly: no wake, no give-up, no further requests', async () => {
    const h = harness([])

    const sleeper = startSleeper(h.options)
    await new Promise((resolve) => setTimeout(resolve, 20))
    sleeper.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(h.urls).toHaveLength(1)
    expect(h.woke).toEqual([])
    expect(h.gaveUp).toEqual([])
  })
})
