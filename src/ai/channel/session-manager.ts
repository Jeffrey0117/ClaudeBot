import type { SessionBackend, SessionLaunchConfig, SessionEvent } from './types.js'

interface LiveSession {
  readonly backend: SessionBackend
  fingerprint: string
  lastUsed: number
}

const IDLE_SWEEP_MS = 10 * 60_000
const MAX_SESSIONS = 6

/** Supervises one warm SessionBackend per key. Transport-agnostic. */
export class ChannelSessionManager {
  private readonly sessions = new Map<string, LiveSession>()
  private sweepTimer: NodeJS.Timeout | null = null

  /** makeBackend lets tests inject a stub; production passes the real factory. */
  constructor(private readonly makeBackend: () => SessionBackend) {}

  async runTurn(
    key: string,
    cfg: SessionLaunchConfig,
    fingerprint: string,
    text: string,
    onEvent: (e: SessionEvent) => void,
  ): Promise<void> {
    const session = await this.ensure(key, cfg, fingerprint)
    session.lastUsed = Date.now()
    this.armSweep()
    await session.backend.send(text, onEvent)
    session.lastUsed = Date.now()
  }

  /** Interrupt the current turn; session survives. Returns true if one existed. */
  interrupt(key: string): boolean {
    const s = this.sessions.get(key)
    if (!s) return false
    void s.backend.interrupt()
    return true
  }

  isBusy(key: string): boolean {
    return this.sessions.get(key)?.backend.isBusy() === true
  }

  hasSession(key: string): boolean {
    return this.sessions.has(key)
  }

  async stop(key: string): Promise<void> {
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    await s.backend.stop().catch(() => {})
  }

  private async ensure(key: string, cfg: SessionLaunchConfig, fingerprint: string): Promise<LiveSession> {
    const existing = this.sessions.get(key)
    if (existing && existing.fingerprint === fingerprint) return existing
    if (existing) {
      // Config changed (model / pairing / system prompt) → transparent restart.
      this.sessions.delete(key)
      await existing.backend.stop().catch(() => {})
    }
    await this.evictIfFull()
    const backend = this.makeBackend()
    await backend.start(cfg)
    const session: LiveSession = { backend, fingerprint, lastUsed: Date.now() }
    this.sessions.set(key, session)
    return session
  }

  private async evictIfFull(): Promise<void> {
    if (this.sessions.size < MAX_SESSIONS) return
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, s] of this.sessions) {
      if (!s.backend.isBusy() && s.lastUsed < oldest) {
        oldest = s.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey) await this.stop(oldestKey)
  }

  private armSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [k, s] of this.sessions) {
        if (!s.backend.isBusy() && now - s.lastUsed > IDLE_SWEEP_MS) void this.stop(k)
      }
      if (this.sessions.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer)
        this.sweepTimer = null
      }
    }, 60_000)
    this.sweepTimer.unref?.()
  }
}
