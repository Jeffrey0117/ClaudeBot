/**
 * Minimal Chrome DevTools Protocol client over WebSocket.
 *
 * Protocol-level page control for CDP-based automations (ig-cdp-flow, etc.):
 *  - Runtime.evaluate (bypasses page CSP / Trusted Types)
 *  - DOM.setFileInputFiles (inject local files without blob fetch)
 *  - Page.bringToFront (wake background tabs — Lexical ignores hidden tabs)
 *
 * Complements chrome-cdp.ts (which handles Chrome launch/setup) and the
 * one-shot eval in remote/tool-handlers/browser-tools.ts.
 */

import { WebSocket } from 'ws'
import { CDP_PORT } from './chrome-cdp.js'
import { CdpEventRouter, type CdpEventHandler } from './cdp-events.js'

export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

/** List all CDP targets (tabs, workers, ...). */
export async function listTargets(): Promise<readonly CdpTarget[]> {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`)
  return (await res.json()) as CdpTarget[]
}

/**
 * Find an open page matching urlPattern, or open openUrl in a new tab.
 * Returns a target with a usable webSocketDebuggerUrl.
 */
export async function findOrOpenPage(urlPattern: RegExp, openUrl: string): Promise<CdpTarget> {
  const targets = await listTargets()
  const existing = targets.find(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && urlPattern.test(t.url),
  )
  if (existing) return existing

  // Modern Chrome (M111+) requires PUT for /json/new.
  // The raw query string IS the URL (no url= param, no encoding).
  const res = await fetch(
    `http://localhost:${CDP_PORT}/json/new?${openUrl}`,
    { method: 'PUT', signal: AbortSignal.timeout(5000) },
  )
  if (!res.ok) throw new Error(`CDP /json/new returned ${res.status}`)
  const created = (await res.json()) as CdpTarget
  if (!created.webSocketDebuggerUrl) {
    throw new Error('CDP opened a tab but returned no webSocketDebuggerUrl')
  }
  return created
}

interface CdpResponse {
  readonly id?: number
  readonly error?: { readonly message?: string }
  readonly result?: unknown
}

/** A connected CDP session to one page target. Always close() when done. */
export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly events = new CdpEventRouter()

  private constructor(private readonly ws: WebSocket) {}

  static connect(wsUrl: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const client = new CdpClient(ws)
      const connectTimer = setTimeout(() => {
        try { ws.close() } catch { /* already closed */ }
        reject(new Error('CDP WebSocket connect timeout'))
      }, 10_000)

      ws.on('open', () => {
        clearTimeout(connectTimer)
        resolve(client)
      })
      ws.on('error', (err) => {
        clearTimeout(connectTimer)
        reject(new Error(`CDP WebSocket error: ${err.message}`))
      })
      ws.on('message', (data) => client.handleMessage(String(data)))
      ws.on('close', () => client.rejectAll(new Error('CDP WebSocket closed')))
    })
  }

  private handleMessage(raw: string): void {
    let msg: CdpResponse
    try {
      msg = JSON.parse(raw) as CdpResponse
    } catch {
      return
    }
    if (msg.id === undefined) {
      // Event (no id): route to subscribers instead of dropping it.
      const ev = msg as { method?: string; params?: unknown }
      if (ev.method) this.events.dispatch(ev.method, ev.params)
      return
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(new Error(msg.error.message ?? 'CDP command failed'))
    } else {
      entry.resolve(msg.result)
    }
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  /** Send a CDP command and await its response. */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  /** Subscribe to a CDP event (e.g. 'Network.responseReceived'). */
  on(method: string, handler: CdpEventHandler): void {
    this.events.on(method, handler)
  }

  /** Unsubscribe a previously-registered event handler. */
  off(method: string, handler: CdpEventHandler): void {
    this.events.off(method, handler)
  }

  close(): void {
    try { this.ws.close() } catch { /* already closed */ }
  }
}
