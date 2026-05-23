/**
 * Agent-browser (ab_*) handlers for remote tools.
 * Chrome CDP connection, browser navigation, screenshots.
 */

import { readFile, unlink } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CDP_PORT,
  isCdpAvailable,
  ensureChromeCdp,
} from '../../bot/vision/chrome-cdp.js'

const AB_TIMEOUT_MS = 60_000 // 60s — heavy pages like Gmail need time to load

const BLOCKED_URL_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|0\.0\.0\.0)/i

function validateUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`)
    }
    if (BLOCKED_URL_RE.test(url)) {
      throw new Error('Access to internal/private URLs is not allowed')
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`)
    }
    throw error
  }
}

/** Run agent-browser CLI. Auto-prepends --cdp flag when Chrome CDP is available. */
async function runAB(...args: readonly string[]): Promise<string> {
  const cdp = await isCdpAvailable()
  const finalArgs = cdp ? ['--cdp', String(CDP_PORT), ...args] : [...args]

  return new Promise((resolve, reject) => {
    execFile(
      'agent-browser',
      finalArgs,
      { timeout: AB_TIMEOUT_MS, shell: true, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message
          reject(new Error(msg))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
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
  // from conflicting with CDP when we restart Chrome below.
  await runAB('close').catch(() => {})

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
