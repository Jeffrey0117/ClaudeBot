/**
 * Agent-browser (ab_*) handlers for remote tools.
 * Chrome CDP connection, browser navigation, screenshots.
 */

import { readFile, unlink } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import {
  CDP_PORT,
  isCdpAvailable,
  ensureChromeCdp,
} from '../../bot/vision/chrome-cdp.js'
import { sniff } from '../../bot/vision/sniffer.js'
import { runUserscript } from '../../bot/vision/userscript-runner.js'
import { validateUrl } from '../../utils/validate-url.js'

const AB_TIMEOUT_MS = 60_000 // 60s — heavy pages like Gmail need time to load

/**
 * Run arbitrary JS in the live Chrome via CDP Runtime.evaluate. Unlike a
 * userscript this is protocol-level: it bypasses the page's CSP / Trusted Types
 * entirely, and userGesture:true lets things like video.play() actually run.
 */
export async function handleBrowserEval(args: Record<string, unknown>): Promise<string> {
  const js = String(args.js ?? args.code ?? args.expression ?? '')
  if (!js) return 'No JS provided'

  if (!(await isCdpAvailable())) {
    await ensureChromeCdp().catch(() => {})
  }

  let targets: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>
  try {
    targets = await fetch(`http://localhost:${CDP_PORT}/json`).then((r) => r.json())
  } catch {
    return 'CDP 連不上（Chrome 沒帶除錯埠?）'
  }
  // Prefer the most recently-opened real http(s) page (usually the active tab).
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && /^https?:/i.test(t.url))
  const target = pages[pages.length - 1] ?? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!target?.webSocketDebuggerUrl) return 'Chrome 沒有可用的分頁'

  return await new Promise<string>((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl!)
    const timer = setTimeout(() => { try { ws.close() } catch { /* */ } resolve('eval 逾時') }, 15_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: js, awaitPromise: true, returnByValue: true, userGesture: true },
      }))
    })
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data)) as {
          id?: number
          result?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value?: unknown; description?: string } }
        }
        if (m.id !== 1) return
        clearTimeout(timer)
        ws.close()
        if (m.result?.exceptionDetails) {
          resolve('JS 錯誤: ' + (m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text ?? 'exception'))
        } else {
          const r = m.result?.result
          resolve(r?.value !== undefined ? JSON.stringify(r.value) : (r?.description ?? 'undefined'))
        }
      } catch { /* ignore */ }
    })
    ws.on('error', () => { clearTimeout(timer); resolve('CDP ws error') })
  })
}

/**
 * Capture a page's XHR/fetch JSON via CDP. Runs on this machine's Chrome.
 * args: { url: string, seconds?: number }. Returns JSON-stringified SniffResult.
 */
export async function handleBrowserSniff(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '')
  if (!url) return 'No url provided'
  validateUrl(url) // throws on internal/private/non-http(s)

  const seconds = Number(args.seconds ?? 8)

  if (!(await isCdpAvailable())) {
    await ensureChromeCdp().catch(() => {})
  }
  const result = await sniff(url, seconds)
  return JSON.stringify(result)
}


/** Run a userscript in this machine's Chrome. args: { code, url, trigger?, seconds?, requires?, resources? } */
export async function handleUserscriptRun(args: Record<string, unknown>): Promise<string> {
  const code = String(args.code ?? '')
  const url = String(args.url ?? '')
  if (!code) return 'No code provided'
  if (!url) return 'No url provided'
  validateUrl(url)
  const trigger = args.trigger != null ? String(args.trigger) : undefined
  const seconds = Number(args.seconds ?? 8)
  const requires = Array.isArray(args.requires) ? (args.requires as string[]) : undefined
  const resources = Array.isArray(args.resources) ? (args.resources as Array<{ name: string; url: string }>) : undefined
  if (!(await isCdpAvailable())) { await ensureChromeCdp().catch(() => {}) }
  const result = await runUserscript(code, { url, trigger, seconds, requires, resources })
  return JSON.stringify(result)
}

/** Raw agent-browser CLI exec. Prepends --cdp when Chrome CDP is available. */
function runABRaw(...args: readonly string[]): Promise<string> {
  return (async () => {
    const cdp = await isCdpAvailable()
    const finalArgs = cdp ? ['--cdp', String(CDP_PORT), ...args] : [...args]
    return new Promise<string>((resolve, reject) => {
      execFile(
        'agent-browser',
        finalArgs,
        { timeout: AB_TIMEOUT_MS, shell: true, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message))
            return
          }
          resolve(stdout.trim())
        },
      )
    })
  })()
}

// Re-entrancy guard: handleBrowserConnect() runs agent-browser too, so we must
// never let auto-connect recurse into another auto-connect.
let autoConnecting = false

/**
 * Run agent-browser with auto-connect. If Chrome CDP isn't up, ab_* tools would
 * otherwise run standalone agent-browser, fail to attach to port 9222 after
 * ~30s, and report "Element not found". So when CDP is down we first launch
 * Chrome with CDP (handleBrowserConnect), then run the command.
 */
async function runAB(...args: readonly string[]): Promise<string> {
  if (!autoConnecting && !(await isCdpAvailable())) {
    autoConnecting = true
    try {
      await handleBrowserConnect()
    } catch { /* fall through — runABRaw will still try standalone */ }
    finally {
      autoConnecting = false
    }
  }
  return runABRaw(...args)
}

let abAvailable: boolean | null = null

function checkBrowserAvailable(): Promise<boolean> {
  return new Promise((res) => {
    execFile('agent-browser', ['--version'], { timeout: 3000, windowsHide: true, shell: true }, (err) => res(!err))
  })
}

async function ensureBrowserAvailable(): Promise<void> {
  // Only cache success — re-check every time if previously unavailable
  // so that installing via remote_execute_command takes effect immediately
  if (abAvailable !== true) abAvailable = await checkBrowserAvailable()
  if (!abAvailable) {
    throw new Error(
      'agent-browser is not installed on this machine. ' +
      'Use remote_execute_command to install it: npm i -g agent-browser — then retry the browser operation.',
    )
  }
}

function validateRef(ref: unknown): string {
  const s = String(ref)
  if (!/^e\d{1,6}$/.test(s)) throw new Error(`Invalid element ref: ${s}`)
  return s
}

function validateKey(key: unknown): string {
  const s = String(key)
  if (s.length > 50) throw new Error('Key name too long')
  return s
}

export async function handleBrowserOpen(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const url = String(args.url)
  validateUrl(url)
  const text = await runAB('open', url)
  return text || `Navigated to ${url}`
}

export async function handleBrowserSnapshot(): Promise<string> {
  await ensureBrowserAvailable()
  return await runAB('snapshot', '-i')
}

export async function handleBrowserClick(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const text = await runAB('click', ref)
  return text || `Clicked ${ref}`
}

export async function handleBrowserFill(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const fillText = String(args.text)
  const text = await runAB('fill', ref, fillText)
  return text || `Filled ${ref}`
}

export async function handleBrowserPress(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const key = validateKey(args.key)
  const text = await runAB('press', key)
  return text || `Pressed ${key}`
}

export async function handleBrowserScreenshot(): Promise<string> {
  await ensureBrowserAvailable()
  const screenshotPath = join(tmpdir(), `ab-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
  await runAB('screenshot', '--output', screenshotPath)
  try {
    const buffer = await readFile(screenshotPath)
    const base64 = buffer.toString('base64')
    return JSON.stringify({ type: 'image', base64, mimeType: 'image/png' })
  } finally {
    await unlink(screenshotPath).catch(() => {})
  }
}

export async function handleBrowserBack(): Promise<string> {
  await ensureBrowserAvailable()
  const text = await runAB('back')
  return text || 'Navigated back'
}

export async function handleBrowserGetUrl(): Promise<string> {
  await ensureBrowserAvailable()
  return await runAB('get', 'url')
}

/**
 * Connect agent-browser to user's Chrome with CDP.
 *
 * Delegates the heavy lifting (patch shortcuts, kill Chrome, relaunch with
 * CDP, poll) to the shared chrome-cdp module so this stays in sync with the
 * Playwright-based /bv path.
 */
export async function handleBrowserConnect(): Promise<string> {
  await ensureBrowserAvailable()

  // Kill agent-browser daemon first — prevents an old standalone session
  // from conflicting with CDP when we restart Chrome below. Use the RAW exec
  // so it never recurses back into auto-connect.
  await runABRaw('close').catch(() => {})

  const result = await ensureChromeCdp()
  return result.alreadyAvailable
    ? `${result.message} Browser tools will use your Chrome with login state.`
    : `${result.message} All ab_* tools will control your Chrome.`
}

/**
 * Spawn a detached process that outlives the agent command.
 * Used by /pair chat to launch Electron without blocking.
 */
export function handleSpawnDetached(args: Record<string, unknown>, baseDir: string): string {
  const cmd = String(args.command || 'npx')
  const cmdArgs: readonly string[] = args.args
    ? JSON.parse(String(args.args))
    : []
  const cwd = args.cwd ? String(args.cwd) : baseDir

  const child = spawn(cmd, [...cmdArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  child.unref()

  return `Spawned detached: ${cmd} ${cmdArgs.join(' ')} (pid ${child.pid ?? 'unknown'})`
}
