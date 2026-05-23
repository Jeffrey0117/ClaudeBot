/**
 * Playwright browser singleton + screenshot capture.
 *
 * Two modes:
 *  1. ATTACHED — connects to the user's real Chrome via CDP (port 9222).
 *     Enabled automatically whenever CDP is available. Uses the user's
 *     actual login state and existing tabs. Never killed on idle.
 *  2. OWNED    — falls back to launching a private headless Chromium.
 *     5-minute idle timeout auto-closes to save memory.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { isCdpAvailable, CDP_CHECK_URL } from './chrome-cdp.js'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const PAGE_TIMEOUT_MS = 30_000
const VIEWPORT = { width: 1280, height: 720 }

let browser: import('playwright').Browser | null = null
let attachedMode = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
let activeRequests = 0

function resetIdleTimer(): void {
  // Never auto-close an attached browser — it's the user's real Chrome
  if (attachedMode) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (activeRequests === 0) closeBrowser()
  }, IDLE_TIMEOUT_MS)
}

/** True if the current browser handle is attached to the user's real Chrome. */
export function isAttachedMode(): boolean {
  return attachedMode && browser?.isConnected() === true
}

export async function getBrowser(): Promise<import('playwright').Browser> {
  if (browser?.isConnected()) {
    resetIdleTimer()
    return browser
  }

  const { chromium } = await import('playwright')

  // Prefer attaching to the user's real Chrome if CDP is up.
  // This makes /bv operate on their actual tabs with real login state.
  if (await isCdpAvailable()) {
    try {
      browser = await chromium.connectOverCDP(CDP_CHECK_URL.replace('/json/version', ''))
      attachedMode = true
      browser.on('disconnected', () => {
        console.log('[browser-pool] CDP-attached Chrome disconnected')
        browser = null
        attachedMode = false
      })
      console.log('[browser-pool] attached to existing Chrome via CDP')
      return browser
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[browser-pool] CDP attach failed, falling back to owned browser: ${msg}`)
      // fall through to headless launch
    }
  }

  // Fallback: spawn our own headless Chromium (original behavior)
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1280,720',
      '--disable-extensions',
      '--disable-crash-reporter',
      '--disable-breakpad',
    ],
  })
  attachedMode = false

  browser.on('disconnected', () => {
    console.error('[browser-pool] Owned browser disconnected unexpectedly')
    browser = null
    attachedMode = false
  })

  resetIdleTimer()
  return browser
}

export async function captureScreenshot(url: string): Promise<string> {
  activeRequests++
  const b = await getBrowser()
  const page = await b.newPage({
    viewport: VIEWPORT,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
    const filename = `bv-${randomBytes(4).toString('hex')}.png`
    const filePath = join(tmpdir(), filename)
    await page.screenshot({ path: filePath, fullPage: false })
    return filePath
  } finally {
    await page.close()
    activeRequests--
    resetIdleTimer()
  }
}

export async function cleanupScreenshot(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch {
    // already deleted or doesn't exist
  }
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (browser) {
    // In attached mode we DON'T close the user's Chrome — just detach.
    if (attachedMode) {
      try {
        await browser.close().catch(() => {})
      } catch { /* ignore */ }
    } else {
      await browser.close().catch(() => {})
    }
    browser = null
    attachedMode = false
  }
}
