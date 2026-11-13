import { readFileSync } from 'node:fs'
import dotenv from 'dotenv'

/**
 * Sleeping bots.
 *
 * A bot nobody is talking to still costs a full process. With sleeping enabled
 * the launcher stops an idle secondary bot and listens to Telegram on its
 * behalf with one cheap long poll; the first incoming update starts the real
 * bot again, which then receives that update itself.
 *
 * The listener only *peeks*: it never sends an offset, so Telegram keeps the
 * update queued for the bot.
 */

const HEARTBEAT_FRESH_MS = 15_000
const DEFAULT_API_BASE = 'https://api.telegram.org'

/** Minutes of inactivity before a secondary bot sleeps; 0/unset/invalid = never. */
export function sleepIdleMsFromEnv(raw: string | undefined): number {
  const minutes = Number(raw)
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** Decide from a bot's heartbeat whether it can be put to sleep now. */
export function isSleepCandidate(heartbeat: unknown, now: number, idleMs: number): boolean {
  if (idleMs <= 0 || !heartbeat || typeof heartbeat !== 'object') return false
  const hb = heartbeat as Record<string, unknown>

  if (typeof hb.updatedAt !== 'number' || now - hb.updatedAt > HEARTBEAT_FRESH_MS) return false
  if (typeof hb.lastActivityAt !== 'number') return false
  if (hb.queueLength !== 0) return false
  if (lengthOf(hb.activeRunners) > 0 || lengthOf(hb.machines) > 0) return false

  return now - hb.lastActivityAt >= idleMs
}

export interface BotEnv {
  readonly token: string
  readonly apiBase: string
}

/** Read what the listener needs from a bot's env file. Null if it has no token. */
export function readBotEnv(file: string): BotEnv | null {
  try {
    const parsed = dotenv.parse(readFileSync(file, 'utf-8'))
    const token = (parsed.BOT_TOKEN ?? '').trim()
    if (!token) return null
    const apiBase = (parsed.TELEGRAM_API_BASE ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE
    return { token, apiBase }
  } catch {
    return null
  }
}

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ json: () => Promise<unknown> }>

export interface SleeperOptions extends BotEnv {
  /** Long-poll duration per request. */
  readonly pollSeconds: number
  readonly retryDelayMs: number
  /** Consecutive failures before giving up (the caller should then start the bot). */
  readonly maxFailures: number
  readonly fetchImpl?: FetchLike
  /** An update is waiting. Called once; the listener has already stopped. */
  readonly onWake: (update: unknown) => void
  /** Listening is not working. Called once; the listener has already stopped. */
  readonly onGiveUp: (reason: string) => void
}

export interface Sleeper {
  readonly stop: () => void
}

interface UpdatesReply {
  readonly ok?: boolean
  readonly result?: unknown
  readonly error_code?: number
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function startSleeper(options: SleeperOptions): Sleeper {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${options.apiBase}/bot${options.token}/getUpdates?timeout=${options.pollSeconds}&limit=1`
  const abort = new AbortController()
  let stopped = false

  const listen = async (): Promise<void> => {
    let failures = 0

    while (!stopped) {
      let problem = ''
      try {
        const reply = (await (await fetchImpl(url, { signal: abort.signal })).json()) as UpdatesReply
        if (stopped) return

        if (reply.ok === true) {
          failures = 0
          if (Array.isArray(reply.result) && reply.result.length > 0) {
            stopped = true
            options.onWake(reply.result[0])
            return
          }
          continue
        }

        if (reply.error_code === 401 || reply.error_code === 404) {
          stopped = true
          options.onGiveUp(`Telegram rejected the token (${reply.error_code})`)
          return
        }
        problem = `Telegram error ${reply.error_code ?? 'unknown'}`
      } catch (error) {
        if (stopped) return
        problem = error instanceof Error ? error.message : String(error)
      }

      failures += 1
      if (failures >= options.maxFailures) {
        stopped = true
        options.onGiveUp(`${failures} failures in a row, last: ${problem}`)
        return
      }
      await delay(options.retryDelayMs)
    }
  }

  void listen()

  return {
    stop: () => {
      stopped = true
      abort.abort()
    },
  }
}
