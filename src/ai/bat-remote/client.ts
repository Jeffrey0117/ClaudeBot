import { EventEmitter } from 'node:events'
import type { TLSSocket } from 'node:tls'
import { WebSocket } from 'ws'

/**
 * Minimal client for BAT's remote WebSocket protocol.
 *
 * Speaks protocol `bat-remote/v2` with compression disabled, so every frame is
 * plain-text JSON (no gzip framing, zero extra deps). See
 * `docs/bat-remote-protocol.md` for the wire format. This is a thin transport:
 * connect + pin cert + auth + request/response `invoke` + fan-out of `event`
 * frames. Higher-level session logic lives in the runner.
 */

const PROTOCOL_V2 = 'bat-remote/v2'
const AUTH_TIMEOUT_MS = 8000
const KEEPALIVE_INTERVAL_MS = 20_000

export interface BatRemoteClientOptions {
  readonly url: string
  readonly token: string
  /** SHA-256 leaf-cert fingerprint (uppercase hex, colon-separated) to pin. */
  readonly fingerprint: string
  readonly label: string
  readonly windowId: string
  readonly deviceId: string
  readonly appName?: string
  readonly appVersion?: string
}

export interface BatRemoteEvent {
  readonly channel: string
  readonly params: Record<string, unknown>
}

interface PendingInvoke {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Normalize a fingerprint to `AA:BB:CC` form for equality checks. */
export function normalizeFingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const pairs: string[] = []
  for (let i = 0; i + 1 < hex.length; i += 2) {
    pairs.push(hex.slice(i, i + 2))
  }
  return pairs.join(':')
}

/**
 * Emits:
 *  - `'event'`  (payload: BatRemoteEvent) — a host state broadcast
 *  - `'close'`  (payload: { code: number; reason: string })
 *  - `'error'`  (payload: Error)
 */
export class BatRemoteClient extends EventEmitter {
  private ws: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<string, PendingInvoke>()
  private keepalive: ReturnType<typeof setInterval> | null = null
  private authenticated = false
  private serverVersion: string | null = null
  private capabilities: Record<string, unknown> | null = null

  constructor(private readonly options: BatRemoteClientOptions) {
    super()
  }

  getServerVersion(): string | null {
    return this.serverVersion
  }

  getCapabilities(): Record<string, unknown> | null {
    return this.capabilities
  }

  isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN
  }

  /** Connect, verify the pinned cert fingerprint, and complete the auth handshake. */
  async connect(): Promise<void> {
    const expected = normalizeFingerprint(this.options.fingerprint)
    if (!expected) throw new Error('bat-remote: a certificate fingerprint is required for TLS pinning')

    const ws = new WebSocket(this.options.url, {
      // The host presents a self-signed cert; CA validation cannot pass. The
      // fingerprint pin below is what actually secures the channel.
      rejectUnauthorized: false,
      perMessageDeflate: false,
    })
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        try { ws.terminate() } catch { /* already gone */ }
        reject(error)
      }

      ws.on('upgrade', (res) => {
        const socket = res.socket as TLSSocket
        const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
        const actual = normalizeFingerprint(cert?.fingerprint256 ?? '')
        if (!actual || actual !== expected) {
          fail(new Error(`bat-remote: certificate fingerprint mismatch (expected ${expected.slice(0, 23)}..., got ${actual.slice(0, 23) || 'none'}...)`))
        }
      })

      ws.on('open', () => {
        const authId = this.makeId()
        this.sendJson({
          type: 'auth',
          id: authId,
          token: this.options.token,
          protocols: [PROTOCOL_V2],
          args: [
            this.options.label,
            {
              windowId: this.options.windowId,
              clientInfo: {
                appName: this.options.appName ?? 'ClaudeBot',
                appVersion: this.options.appVersion ?? '0.0.0',
                deviceName: this.options.label,
                label: this.options.label,
                deviceId: this.options.deviceId,
                platform: process.platform,
              },
            },
          ],
        })
      })

      const authTimer = setTimeout(() => fail(new Error('bat-remote: auth timed out')), AUTH_TIMEOUT_MS)

      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        // Compression is not negotiated, so every frame is text JSON. A binary
        // frame here would mean the host forced gzip — unsupported by this PoC.
        if (isBinary) {
          fail(new Error('bat-remote: received a binary frame but gzip compression is not supported by this client'))
          return
        }
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>
        } catch {
          return
        }

        if (!settled && frame.type === 'auth-result') {
          clearTimeout(authTimer)
          if (typeof frame.error === 'string') {
            fail(new Error(`bat-remote: auth rejected: ${frame.error}`))
            return
          }
          this.authenticated = true
          this.serverVersion = typeof frame.serverVersion === 'string' ? frame.serverVersion : null
          this.capabilities = isRecord(frame.capabilities) ? frame.capabilities : null
          settled = true
          this.startKeepalive()
          resolve()
          return
        }

        this.handleFrame(frame)
      })

      ws.on('error', (error: Error) => {
        if (!settled) fail(error)
        else this.emit('error', error)
      })

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(authTimer)
        this.stopKeepalive()
        this.authenticated = false
        this.drainPending('bat-remote: connection closed')
        if (!settled) {
          fail(new Error(`bat-remote: socket closed before auth (code ${code})`))
        } else {
          this.emit('close', { code, reason: reason.toString('utf-8') })
        }
      })
    })
  }

  /** Call a host method and await its `invoke-result` / `invoke-error`. */
  invoke(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('bat-remote: not connected'))
        return
      }
      const id = this.makeId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bat-remote: invoke timed out: ${channel}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sendJson({ type: 'invoke', id, channel, params, args: [] })
    })
  }

  close(): void {
    this.stopKeepalive()
    this.drainPending('bat-remote: closed by client')
    const ws = this.ws
    this.ws = null
    this.authenticated = false
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close() } catch { /* ignore */ }
    } else if (ws) {
      try { ws.terminate() } catch { /* ignore */ }
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = frame.type
    if (type === 'invoke-result' || type === 'invoke-error') {
      const id = typeof frame.id === 'string' ? frame.id : null
      if (!id) return
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (type === 'invoke-error') {
        pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'bat-remote: invoke failed'))
      } else {
        pending.resolve(frame.result ?? null)
      }
      return
    }

    if (type === 'event') {
      const channel = typeof frame.channel === 'string' ? frame.channel : ''
      if (!channel) return
      const params = isRecord(frame.params) ? frame.params : {}
      this.emit('event', { channel, params } satisfies BatRemoteEvent)
      return
    }
    // `pong` and anything else: ignored.
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepalive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.ping() } catch { /* the close handler will fire */ }
      }
    }, KEEPALIVE_INTERVAL_MS)
    this.keepalive.unref?.()
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }

  private drainPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  private sendJson(frame: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(frame))
  }

  private makeId(): string {
    this.nextId += 1
    return `${Date.now()}-${this.nextId}`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
