/**
 * Persistent browser page session for multi-step web agent operations.
 *
 * Reuses the browser singleton from browser-pool.ts.
 * Max 3 concurrent sessions, 5-minute idle auto-close.
 * One active session per chatId.
 */

import { getBrowser } from './browser-pool.js'
import { isSsrfBlocked } from './ssrf-guard.js'
import type { Page } from 'playwright'

const MAX_SESSIONS = 3
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const PAGE_TIMEOUT_MS = 30_000
const SETTLE_DELAY_MS = 500
const VIEWPORT = { width: 1280, height: 720 }

export interface BrowserSession {
  readonly chatId: number
  readonly page: Page
  readonly createdAt: number
}

const sessions = new Map<number, { session: BrowserSession; idleTimer: ReturnType<typeof setTimeout> }>()

function resetSessionIdle(chatId: number): void {
  const entry = sessions.get(chatId)
  if (!entry) return
  clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => closeSession(chatId), IDLE_TIMEOUT_MS)
}

export async function createSession(chatId: number): Promise<BrowserSession> {
  // Close existing session for this chat
  if (sessions.has(chatId)) {
    await closeSession(chatId)
  }

  // Enforce max concurrent sessions — close oldest
  if (sessions.size >= MAX_SESSIONS) {
    let oldestId: number | null = null
    let oldestTime = Infinity
    for (const [id, entry] of sessions) {
      if (entry.session.createdAt < oldestTime) {
        oldestTime = entry.session.createdAt
        oldestId = id
      }
    }
    if (oldestId !== null) await closeSession(oldestId)
  }

  const browser = await getBrowser()
  const page = await browser.newPage({ viewport: VIEWPORT })

  const session: BrowserSession = {
    chatId,
    page,
    createdAt: Date.now(),
  }

  const idleTimer = setTimeout(() => closeSession(chatId), IDLE_TIMEOUT_MS)
  sessions.set(chatId, { session, idleTimer })

  return session
}

export async function sessionNavigate(session: BrowserSession, url: string): Promise<void> {
  if (isSsrfBlocked(url)) {
    throw new Error('不允許存取內部網路位址')
  }
  resetSessionIdle(session.chatId)
  await session.page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
}

export async function sessionScreenshot(session: BrowserSession): Promise<string> {
  resetSessionIdle(session.chatId)
  const buffer = await session.page.screenshot({ fullPage: false })
  return buffer.toString('base64')
}

export async function sessionAccessTree(session: BrowserSession): Promise<string> {
  resetSessionIdle(session.chatId)
  const snapshot = await session.page.locator('body').ariaSnapshot({ timeout: 10_000 })
  return snapshot || '(empty accessibility tree)'
}

export async function sessionClick(session: BrowserSession, selector: string): Promise<void> {
  resetSessionIdle(session.chatId)
  const locator = resolveLocator(session.page, selector)
  await locator.click({ timeout: PAGE_TIMEOUT_MS })
}

export async function sessionFill(session: BrowserSession, selector: string, text: string): Promise<void> {
  resetSessionIdle(session.chatId)
  const locator = resolveLocator(session.page, selector)
  await locator.fill(text, { timeout: PAGE_TIMEOUT_MS })
}

export async function sessionPress(session: BrowserSession, key: string): Promise<void> {
  resetSessionIdle(session.chatId)
  await session.page.keyboard.press(key)
}

export async function sessionScroll(session: BrowserSession, direction: string): Promise<void> {
  resetSessionIdle(session.chatId)
  const delta = direction === 'up' ? -500 : 500
  await session.page.mouse.wheel(0, delta)
}

export async function sessionWaitForSettle(session: BrowserSession): Promise<void> {
  resetSessionIdle(session.chatId)
  try {
    await session.page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch {
    // networkidle timeout is fine — some pages never settle
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS))
}

export async function closeSession(chatId: number): Promise<void> {
  const entry = sessions.get(chatId)
  if (!entry) return
  clearTimeout(entry.idleTimer)
  sessions.delete(chatId)
  try {
    await entry.session.page.close()
  } catch {
    // page already closed
  }
}

/**
 * Translate agent selectors to Playwright locators.
 * Supports:
 *   role=button[name="Submit"]  → page.getByRole('button', { name: 'Submit' })
 *   text="登入"                 → page.getByText('登入')
 *   #search-input               → page.locator('#search-input')
 *   .my-class                   → page.locator('.my-class')
 */
function resolveLocator(page: Page, selector: string): ReturnType<Page['locator']> {
  // role=button[name="Submit"]
  const roleMatch = selector.match(/^role=(\w+)\[name="(.+)"\]$/)
  if (roleMatch) {
    return page.getByRole(roleMatch[1] as Parameters<Page['getByRole']>[0], { name: roleMatch[2] })
  }

  // text="something"
  const textMatch = selector.match(/^text="(.+)"$/)
  if (textMatch) {
    return page.getByText(textMatch[1])
  }

  // CSS selector fallback
  return page.locator(selector)
}
