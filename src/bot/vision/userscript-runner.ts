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
    // For instagram.com requests, add the browser headers IG's API requires
    // (Referer/Origin/UA/CSRF/AppID) — Node fetch doesn't add them and IG 400s
    // without them. Script-set headers still win (spread after defaults).
    const isIg = /instagram\.com/.test(String(req.url))
    const defaults: Record<string, string> = {}
    if (isIg) {
      defaults.Referer = 'https://www.instagram.com/'
      defaults.Origin = 'https://www.instagram.com'
      defaults['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      defaults['X-Requested-With'] = 'XMLHttpRequest'
      defaults['X-IG-App-ID'] = '936619743392459'
      const csrf = /csrftoken=([^;]+)/.exec(cookieHeader)
      if (csrf) defaults['X-CSRFToken'] = csrf[1]
    }
    const headers: Record<string, string> = { ...defaults, ...(req.headers ?? {}) }
    if (cookieHeader && !Object.keys(headers).some((h) => h.toLowerCase() === 'cookie')) headers.Cookie = cookieHeader
    const res = await fetch(String(req.url), { method: req.method ?? 'GET', headers, body: req.data ?? undefined })
    logs.push(`xhr ${res.status}: ${String(req.url).slice(0, 70)}`)
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

    // Fetch @require libs on the Node side (no CORS). Injected separately below
    // so one bad lib doesn't abort the rest, and so UMD/CJS each get the right env.
    const requireLibs: Array<{ url: string; code: string }> = []
    for (const u of opts.requires ?? []) {
      try {
        const r = await fetch(u)
        if (r.ok) requireLibs.push({ url: u, code: await r.text() })
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

    // Inject each @require lib in isolation. UMD/global libs (jQuery) raw so they
    // set window.$/window.jQuery; only CommonJS .cjs bundles (mediabunny) get a
    // local module + are exposed to a global. A throwing lib only logs.
    for (const lib of requireLibs) {
      const isCjs = /\.cjs($|\?)/i.test(lib.url)
      const expr = isCjs
        ? `;(function(){var module={exports:{}};var exports=module.exports;try{\n${lib.code}\n}catch(e){}try{var E=module.exports;if(E){window.Mediabunny=window.Mediabunny||E;window.mediabunny=window.mediabunny||E;}}catch(e){}})();`
        : lib.code
      const rr = await client.send<EvalResult>('Runtime.evaluate', { expression: expr, awaitPromise: false })
      if (rr.exceptionDetails) {
        logs.push(`require error ${lib.url.split('/').pop()}: ${rr.exceptionDetails.exception?.description ?? rr.exceptionDetails.text ?? 'err'}`)
      }
    }

    const shim = buildGmShim(BINDING)
    const dlShim = buildDownloadShim(BINDING)
    const resInit = `window.__cbRes=${JSON.stringify(resObj)};`
    const injected = await client.send<EvalResult>('Runtime.evaluate', {
      expression: `${resInit}${shim};${dlShim}\n;${code}`,
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
    let lastLen = -1
    let stable = 0
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
      // Early exit: once a file is captured and the array is quiet for ~1.5s,
      // stop (keeps simple scripts fast even with a long max window).
      const hasFile = arr.some((m) => m.kind === 'filedata' || m.kind === 'download')
      if (arr.length === lastLen) stable++
      else { stable = 0; lastLen = arr.length }
      if (hasFile && stable >= 6) break
    }

    // Diagnostic probe — what state is the page in after the run?
    try {
      const probe = await client.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: `JSON.stringify({jq: typeof window.$, dwBtns: document.querySelectorAll('.IG_DW_MAIN').length, igEls: document.querySelectorAll('[class*="IG_"]').length, sample: [].slice.call(document.querySelectorAll('[class*="IG_"]'),0,4).map(function(e){return e.className}).join(' | ').slice(0,120), mb: typeof window.Mediabunny, title: (document.title||'').slice(0,30)})`,
        returnByValue: true,
      })
      logs.push('probe: ' + (probe.result?.value ?? '?'))
    } catch { /* */ }

    // Final read — captures filedata / download entries accumulated during the run
    const finalDump = await client.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: `JSON.stringify(window[${JSON.stringify(BINDING)}] || [])`,
      returnByValue: true,
    })
    let captured: Array<{ kind?: string; url?: string; name?: string; dataUrl?: string }> = []
    try { captured = JSON.parse(finalDump.result?.value ?? '[]') } catch { /* */ }
    logs.push(`captured ${captured.length}: ${captured.map((c) => c.kind ?? '?').join(',')}`)
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
