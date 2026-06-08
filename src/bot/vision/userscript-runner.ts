/**
 * Userscript runner — injects a Greasemonkey-style script into the real
 * Chrome via CDP (CSP-bypassed), captures GM_download / GM_xmlhttpRequest
 * calls through a CDP binding, fetches the requested files on the Node side
 * (no CORS), and returns them as base64 blobs.
 */

import { CdpClient, listTargets, findOrOpenPage } from './cdp-client.js'
import { isCdpAvailable, ensureChromeCdp } from './chrome-cdp.js'
import { buildGmShim, buildDownloadShim } from './gm-shim.js'

const BINDING = '__cbGM'
const MAX_FILE_BYTES = 20 * 1024 * 1024

export interface RunFile {
  readonly name: string
  readonly base64: string
}

export interface RunResult {
  readonly files: RunFile[]
  readonly logs: string[]
}

/**
 * Shape of the value resolved by CdpClient.send<EvalResult>('Runtime.evaluate').
 * CdpClient resolves with msg.result (the CDP response's result field), which for
 * Runtime.evaluate is { result?: RemoteObject; exceptionDetails?: ExceptionDetails }.
 */
interface EvalResult {
  exceptionDetails?: {
    exception?: { description?: string }
    text?: string
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const b = u.pathname.split('/').filter(Boolean).pop() ?? 'file'
    return b.includes('.') ? b : `${b}.bin`
  } catch {
    return 'file.bin'
  }
}

async function serviceXhr(
  client: CdpClient,
  req: { id?: number; url?: string; method?: string; headers?: Record<string, string>; data?: string | null; responseType?: string },
  cookieHeader: string,
  logs: string[],
): Promise<void> {
  try {
    const headers: Record<string, string> = { ...(req.headers ?? {}) }
    if (cookieHeader && !Object.keys(headers).some((h) => h.toLowerCase() === 'cookie')) headers.Cookie = cookieHeader
    const res = await fetch(String(req.url), { method: req.method ?? 'GET', headers, body: req.data ?? undefined })
    const wantBinary = req.responseType === 'blob' || req.responseType === 'arraybuffer'
    let resp: Record<string, unknown>
    if (wantBinary) {
      const buf = Buffer.from(await res.arrayBuffer())
      resp = { status: res.status, statusText: res.statusText, base64: buf.toString('base64'), finalUrl: res.url }
    } else {
      resp = { status: res.status, statusText: res.statusText, responseText: await res.text(), finalUrl: res.url }
    }
    await client.send('Runtime.evaluate', { expression: `window.__cbXhrResolve(${req.id}, ${JSON.stringify(resp)})`, awaitPromise: false })
  } catch (err) {
    logs.push(`xhr failed: ${req.url} (${err instanceof Error ? err.message : String(err)})`)
    try { await client.send('Runtime.evaluate', { expression: `window.__cbXhrResolve(${req.id}, {error:${JSON.stringify(String(err))}})`, awaitPromise: false }) } catch { /* */ }
  }
}

/**
 * Inject `code` (CSP-bypassed) into the CDP Chrome at `url`, run optional
 * `trigger`, and capture downloads the script requests via GM_download/xhr
 * (routed through a CDP binding → fetched here on the Node side, no CORS).
 * Returns files as base64 plus diagnostic logs.
 */
export async function runUserscript(
  code: string,
  opts: { url: string; trigger?: string; seconds?: number; requires?: readonly string[]; resources?: ReadonlyArray<{ name: string; url: string }> },
): Promise<RunResult> {
  const secs = Math.min(30, Math.max(3, Math.floor(opts.seconds ?? 8)))
  const logs: string[] = []
  const files: RunFile[] = []
  const downloadReqs: Array<{ url: string; name: string }> = []
  const fileDatas: RunFile[] = []

  if (!(await isCdpAvailable())) await ensureChromeCdp()

  const targets = await listTargets()
  const blank = targets.find(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      /^(about:blank|chrome:\/\/newtab\/?)$/.test(t.url),
  )
  const target = blank ?? (await findOrOpenPage(/^about:blank$/, 'about:blank'))
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome 沒有可用的分頁')

  const client = await CdpClient.connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    // Fetch @require and @resource on the Node side (no CORS, CSP-bypass)
    let requireBlob = ''
    for (const u of opts.requires ?? []) {
      try {
        const r = await fetch(u)
        if (r.ok) requireBlob += `\n;${await r.text()}\n;`
        else logs.push(`require ${r.status}: ${u}`)
      } catch { logs.push(`require failed: ${u}`) }
    }
    const resObj: Record<string, string> = {}
    for (const res of opts.resources ?? []) {
      try {
        const r = await fetch(res.url)
        if (r.ok) resObj[res.name] = await r.text()
        else logs.push(`resource ${r.status}: ${res.name}`)
      } catch { logs.push(`resource failed: ${res.name}`) }
    }

    await client.send('Page.navigate', { url: opts.url })
    await wait(2000) // settle (document-end style injection)

    // Read cookies from the navigated page (for GM_xmlhttpRequest injection)
    let cookieHeader = ''
    try {
      await client.send('Network.enable')
      const ck = await client.send<{ cookies?: Array<{ name: string; value: string; domain: string }> }>('Network.getAllCookies')
      cookieHeader = (ck.cookies ?? [])
        .filter((c) => /instagram\.com$/.test(c.domain.replace(/^\./, '')))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')
    } catch { /* no cookies */ }

    const shim = buildGmShim(BINDING)
    const dlShim = buildDownloadShim(BINDING)
    const cjsShim = 'var module={exports:{}};var exports=module.exports;'
    const resInit = `window.__cbRes=${JSON.stringify(resObj)};`
    const injected = await client.send<EvalResult>('Runtime.evaluate', {
      expression: `${cjsShim}${resInit}${requireBlob}${shim};${dlShim}\n;${code}`,
      awaitPromise: false,
      userGesture: true,
    })
    if (injected.exceptionDetails) {
      logs.push(
        'script error: ' +
          (injected.exceptionDetails.exception?.description ??
            injected.exceptionDetails.text ??
            'exception'),
      )
    }

    if (opts.trigger) {
      const triggered = await client.send<EvalResult>('Runtime.evaluate', {
        expression: opts.trigger,
        awaitPromise: false,
        userGesture: true,
      })
      if (triggered.exceptionDetails) {
        logs.push(
          'trigger error: ' +
            (triggered.exceptionDetails.exception?.description ??
              triggered.exceptionDetails.text ??
              'exception'),
        )
      }
    }

    // Polling loop — services GM_xmlhttpRequest live during the wait window
    const processedXhr = new Set<number>()
    const deadline = Date.now() + secs * 1000
    while (Date.now() < deadline) {
      await wait(250)
      const poll = await client.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: `JSON.stringify(window[${JSON.stringify(BINDING)}] || [])`,
        returnByValue: true,
      })
      let arr: Array<{ kind?: string; id?: number; url?: string; method?: string; headers?: Record<string, string>; data?: string | null; responseType?: string }> = []
      try { arr = JSON.parse(poll.result?.value ?? '[]') } catch { /* */ }
      for (const msg of arr) {
        if (msg.kind === 'xhr' && typeof msg.id === 'number' && !processedXhr.has(msg.id) && msg.url) {
          processedXhr.add(msg.id)
          void serviceXhr(client, msg, cookieHeader, logs)
        }
      }
    }

    // Final read — captures filedata / download entries accumulated during the run
    const finalDump = await client.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: `JSON.stringify(window[${JSON.stringify(BINDING)}] || [])`,
      returnByValue: true,
    })
    let captured: Array<{ kind?: string; url?: string; name?: string; dataUrl?: string }> = []
    try { captured = JSON.parse(finalDump.result?.value ?? '[]') } catch { /* */ }
    logs.push(`captured ${captured.length} item(s)`)
    for (const msg of captured) {
      if (msg.kind === 'filedata' && msg.dataUrl) {
        const m = /^data:[^;]*;base64,(.*)$/s.exec(msg.dataUrl)
        if (m && m[1].length * 0.75 <= MAX_FILE_BYTES) fileDatas.push({ name: msg.name || 'download', base64: m[1] })
        else logs.push('filedata too big or not base64, skipped')
      } else if (msg.kind === 'download' && msg.url) {
        downloadReqs.push({ url: msg.url, name: msg.name ?? basenameFromUrl(msg.url) })
      }
    }

    for (const req of downloadReqs.slice(0, 20)) {
      try {
        const res = await fetch(req.url)
        if (!res.ok) {
          logs.push(`fetch ${res.status}: ${req.url}`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength > MAX_FILE_BYTES) {
          logs.push(`skip >20MB: ${req.url}`)
          continue
        }
        files.push({ name: req.name, base64: buf.toString('base64') })
      } catch (err) {
        logs.push(
          `fetch failed: ${req.url} (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    files.push(...fileDatas)
    return { files, logs }
  } finally {
    client.close()
  }
}
