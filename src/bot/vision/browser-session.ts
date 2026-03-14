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
const NAV_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 10_000
const SETTLE_DELAY_MS = 500
const VIEWPORT = { width: 1280, height: 720 }
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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
  const page = await browser.newPage({
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
  })

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
  await session.page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
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

  // Check if element exists in DOM at all
  const count = await locator.count()
  if (count === 0) {
    throw new Error(`元素不存在: ${selector}`)
  }

  // Try normal click first
  try {
    await locator.first().click({ timeout: ACTION_TIMEOUT_MS })
    return
  } catch {
    // Normal click failed — try scroll into view + force click
  }

  try {
    await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 })
    await locator.first().click({ timeout: 5000, force: true })
  } catch {
    throw new Error(`元素存在但無法點擊 (可能被遮擋或不可見): ${selector}`)
  }
}

export async function sessionFill(session: BrowserSession, selector: string, text: string): Promise<void> {
  resetSessionIdle(session.chatId)
  const locator = resolveLocator(session.page, selector)

  const count = await locator.count()
  if (count === 0) {
    throw new Error(`元素不存在: ${selector}`)
  }

  try {
    await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 })
  } catch { /* ignore scroll failure */ }

  await locator.first().fill(text, { timeout: ACTION_TIMEOUT_MS })
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
/** Known ARIA role names — used to auto-detect bare role selectors from Gemini. */
const ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button',
  'cell', 'checkbox', 'combobox', 'complementary', 'contentinfo', 'definition',
  'dialog', 'directory', 'document', 'feed', 'figure', 'form', 'grid',
  'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox',
  'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note',
  'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region',
  'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table',
  'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip',
  'tree', 'treegrid', 'treeitem',
])

function resolveLocator(page: Page, selector: string): ReturnType<Page['locator']> {
  // role=button[name="Submit"]
  const roleMatch = selector.match(/^role=(\w+)\[name="(.+)"\]$/)
  if (roleMatch) {
    return page.getByRole(roleMatch[1] as Parameters<Page['getByRole']>[0], { name: roleMatch[2] })
  }

  // Auto-detect bare role: combobox[name="搜尋"] → getByRole('combobox', { name: '搜尋' })
  const bareRoleMatch = selector.match(/^(\w+)\[name="(.+)"\]$/)
  if (bareRoleMatch && ARIA_ROLES.has(bareRoleMatch[1])) {
    return page.getByRole(bareRoleMatch[1] as Parameters<Page['getByRole']>[0], { name: bareRoleMatch[2] })
  }

  // text="something" — with fallback for split-element text
  const textMatch = selector.match(/^text="(.+)"$/)
  if (textMatch) {
    const fullText = textMatch[1]
    const locator = page.getByText(fullText, { exact: true })

    // Sync check not possible, return a smart locator:
    // Try exact first, then fallback to last segment (for split elements like "沒有帳號？註冊")
    return locator.or(page.getByText(extractLastSegment(fullText), { exact: true }))
  }

  // CSS selector fallback
  return page.locator(selector)
}

/** Extract the last meaningful segment from combined text like "沒有帳號？註冊" → "註冊" */
function extractLastSegment(text: string): string {
  // Split on common delimiters: ？?、，,/| and whitespace
  const parts = text.split(/[？?、，,/|\s]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : text
}
