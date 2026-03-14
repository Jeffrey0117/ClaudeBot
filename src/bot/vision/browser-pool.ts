/**
 * Playwright browser singleton + screenshot capture.
 *
 * Lazy init: browser only starts on first use.
 * 5-minute idle timeout: auto-closes to save memory.
 * Each request opens a fresh page (avoids stale state).
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { unlink } from 'node:fs/promises'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const PAGE_TIMEOUT_MS = 30_000
const VIEWPORT = { width: 1280, height: 720 }

let browser: import('playwright').Browser | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let activeRequests = 0

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (activeRequests === 0) closeBrowser()
  }, IDLE_TIMEOUT_MS)
}

export async function getBrowser(): Promise<import('playwright').Browser> {
  if (browser?.isConnected()) {
    resetIdleTimer()
    return browser
  }

  const { chromium } = await import('playwright')
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
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
    await browser.close().catch(() => {})
    browser = null
  }
}
