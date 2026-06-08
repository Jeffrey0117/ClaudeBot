import { CdpClient, listTargets, findOrOpenPage } from './cdp-client.js'

export interface SniffedCall {
  readonly method: string
  readonly url: string
  readonly status: number
  readonly mimeType: string
  readonly bodyBytes: number
  readonly bodyPreview: string
}

export interface SniffResult {
  readonly pageUrl: string
  readonly capturedMs: number
  readonly calls: readonly SniffedCall[]
  readonly droppedCount: number
}

const KEEP_TYPES = new Set(['XHR', 'Fetch'])

/** Keep only XHR/Fetch responses whose mime looks like JSON (or text/plain). */
export function shouldKeep(resourceType: string, mimeType: string): boolean {
  if (!KEEP_TYPES.has(resourceType)) return false
  const m = mimeType.toLowerCase()
  return m.includes('json') || m.includes('text/plain')
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} …(截斷)`
}

/** Keep the last entry for each method+url pair, preserving first-seen order. */
export function dedupeByMethodUrl(calls: readonly SniffedCall[]): SniffedCall[] {
  const byKey = new Map<string, SniffedCall>()
  const order: string[] = []
  for (const c of calls) {
    const key = `${c.method} ${c.url}`
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, c)
  }
  return order.map((k) => byKey.get(k)!)
}

interface RespMeta {
  readonly url: string
  readonly status: number
  readonly mimeType: string
}

/**
 * Navigate the CDP Chrome to `url`, capture XHR/fetch JSON for `seconds`,
 * return the deduped list with truncated body previews. Clamps seconds to 3..20.
 */
export async function sniff(url: string, seconds: number): Promise<SniffResult> {
  const secs = Math.min(20, Math.max(3, Math.floor(seconds || 8)))

  // Pick a page target to drive. Prefer a BLANK/new-tab target so we never
  // navigate the user's active page away (destructive); only open a fresh
  // about:blank tab if none exists. We enable Network BEFORE navigating so
  // load-time calls are captured (hence about:blank, not findOrOpenPage(url)).
  const targets = await listTargets()
  const blank = targets.find(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && /^(about:blank|chrome:\/\/newtab\/?)$/.test(t.url),
  )
  const target = blank ?? (await findOrOpenPage(/^about:blank$/, 'about:blank'))
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome 沒有可用的分頁')

  const client = await CdpClient.connect(target.webSocketDebuggerUrl)
  const meta = new Map<string, RespMeta>()
  const methods = new Map<string, string>()
  const order: string[] = []
  let dropped = 0

  try {
    await client.send('Network.enable')
    await client.send('Page.enable')

    client.on('Network.requestWillBeSent', (p) => {
      const e = p as { requestId?: string; request?: { method?: string } }
      if (e.requestId && e.request?.method) methods.set(e.requestId, e.request.method)
    })

    client.on('Network.responseReceived', (p) => {
      const e = p as { requestId?: string; type?: string; response?: { url: string; status: number; mimeType: string } }
      if (!e.requestId || !e.response) return
      if (!shouldKeep(e.type ?? '', e.response.mimeType ?? '')) {
        dropped++
        return
      }
      if (!meta.has(e.requestId)) order.push(e.requestId)
      meta.set(e.requestId, { url: e.response.url, status: e.response.status, mimeType: e.response.mimeType })
    })

    const startedAt = Date.now()
    await client.send('Page.navigate', { url })
    await new Promise<void>((r) => setTimeout(r, secs * 1000))

    const calls: SniffedCall[] = []
    for (const rid of order) {
      const m = meta.get(rid)!
      let bodyPreview = '(body unavailable)'
      let bodyBytes = 0
      try {
        const b = await client.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: rid })
        const decoded = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf-8') : b.body
        bodyBytes = Buffer.byteLength(decoded)
        bodyPreview = truncate(decoded, 800)
      } catch {
        /* body evicted or binary */
      }
      calls.push({
        method: methods.get(rid) ?? 'GET',
        url: m.url,
        status: m.status,
        mimeType: m.mimeType,
        bodyBytes,
        bodyPreview,
      })
    }

    return {
      pageUrl: url,
      capturedMs: Date.now() - startedAt,
      calls: dedupeByMethodUrl(calls),
      droppedCount: dropped,
    }
  } finally {
    client.close()
  }
}
