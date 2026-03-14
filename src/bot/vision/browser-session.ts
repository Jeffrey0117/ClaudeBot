/**
 * Persistent browser page session for multi-step web agent operations.
 *
 * Reuses the browser singleton from browser-pool.ts.
 * Max 3 concurrent sessions, 5-minute idle auto-close.
 * One active session per chatId.
 */

import { getBrowser } from './browser-pool.js'
import { isSsrfBlocked } from './ssrf-guard.js'
import type { Page, Frame, Locator } from 'playwright'

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
  const { locator, source } = await findElement(session.page, selector)

  if (!locator) {
    // Locator not found — try deep click (DOM walking including shadow DOM)
    const textMatch = selector.match(/^text="(.+)"$/)
    if (textMatch) {
      const clicked = await sessionDeepClick(session, textMatch[1])
      if (clicked) return

      // Also try last segment (e.g. "沒有帳號？註冊" → "註冊")
      const lastSeg = extractLastSegment(textMatch[1])
      if (lastSeg !== textMatch[1]) {
        const clickedSeg = await sessionDeepClick(session, lastSeg)
        if (clickedSeg) return
      }
    }

    const debug = await getPageDebugInfo(session.page, selector)
    throw new Error(`元素不存在: ${selector}。${debug}`)
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
    return
  } catch {
    // Force click also failed — try deep click as last resort
  }

  // Last resort: deep click via DOM walking
  const textMatch = selector.match(/^text="(.+)"$/)
  if (textMatch) {
    const clicked = await sessionDeepClick(session, textMatch[1])
    if (clicked) return

    const lastSeg = extractLastSegment(textMatch[1])
    if (lastSeg !== textMatch[1]) {
      const clickedSeg = await sessionDeepClick(session, lastSeg)
      if (clickedSeg) return
    }
  }

  throw new Error(`元素存在(${source})但無法點擊: ${selector}`)
}

export async function sessionFill(session: BrowserSession, selector: string, text: string): Promise<void> {
  resetSessionIdle(session.chatId)
  const { locator } = await findElement(session.page, selector)

  if (!locator) {
    const debug = await getPageDebugInfo(session.page, selector)
    throw new Error(`元素不存在: ${selector}。${debug}`)
  }

  try {
    await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 })
  } catch { /* ignore scroll failure */ }

  await locator.first().fill(text, { timeout: ACTION_TIMEOUT_MS })
}

export async function sessionClickXY(session: BrowserSession, x: number, y: number): Promise<void> {
  resetSessionIdle(session.chatId)
  await session.page.mouse.click(x, y)
}

/**
 * Nuclear option: walk entire DOM including shadow roots via page.evaluate(),
 * find element by text content, and click it via JS.
 * Returns true if found and clicked.
 */
export async function sessionDeepClick(session: BrowserSession, text: string): Promise<boolean> {
  resetSessionIdle(session.chatId)
  return session.page.evaluate((searchText: string) => {
    function findInNode(root: Document | ShadowRoot | Element): HTMLElement | null {
      // Search text nodes
      const walker = document.createTreeWalker(
        root instanceof Document ? root.body : root,
        NodeFilter.SHOW_TEXT,
      )
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (node.textContent && node.textContent.trim().includes(searchText)) {
          const el = node.parentElement
          if (el && el.offsetParent !== null) return el
        }
      }
      // Search shadow roots
      const elements = (root instanceof Document ? root.body : root).querySelectorAll('*')
      for (const el of elements) {
        if ((el as HTMLElement).shadowRoot) {
          const found = findInNode((el as HTMLElement).shadowRoot!)
          if (found) return found
        }
      }
      // Search iframes
      const iframes = (root instanceof Document ? root : root).querySelectorAll('iframe')
      for (const iframe of iframes) {
        try {
          const doc = (iframe as HTMLIFrameElement).contentDocument
          if (doc) {
            const found = findInNode(doc)
            if (found) return found
          }
        } catch { /* cross-origin */ }
      }
      return null
    }

    const el = findInNode(document)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    }
    return false
  }, text)
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

// --- Smart element finding: main page + all frames ---

interface FindResult {
  readonly locator: Locator | null
  readonly source: string
}

async function findElement(page: Page, selector: string): Promise<FindResult> {
  // 1. Try main page
  const mainLocator = resolveLocator(page, selector)
  try {
    if (await mainLocator.count() > 0) {
      return { locator: mainLocator, source: 'main' }
    }
  } catch { /* count failed, try frames */ }

  // 2. Try all iframes
  const frames = page.frames()
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue
    try {
      const frameLoc = resolveLocatorForFrame(frame, selector)
      if (await frameLoc.count() > 0) {
        return { locator: frameLoc, source: `iframe:${frame.url().slice(0, 50)}` }
      }
    } catch { continue }
  }

  // 3. Last resort: try page.locator with CSS :text() which can be more flexible
  try {
    const textMatch = selector.match(/^text="(.+)"$/)
    if (textMatch) {
      const cssTextLocator = page.locator(`:text("${textMatch[1]}")`)
      if (await cssTextLocator.count() > 0) {
        return { locator: cssTextLocator, source: 'css-text' }
      }
      // Also try with the last segment
      const lastSeg = extractLastSegment(textMatch[1])
      if (lastSeg !== textMatch[1]) {
        const segLocator = page.locator(`:text("${lastSeg}")`)
        if (await segLocator.count() > 0) {
          return { locator: segLocator, source: 'css-text-segment' }
        }
      }
    }
  } catch { /* ignore */ }

  return { locator: null, source: 'not-found' }
}

/** Debug info when element not found — helps diagnose iframe/shadow DOM issues */
async function getPageDebugInfo(page: Page, selector: string): Promise<string> {
  const parts: string[] = []

  // Check iframe count
  const frameCount = page.frames().length
  if (frameCount > 1) {
    parts.push(`頁面有 ${frameCount - 1} 個 iframe`)
  }

  // Check page URL (might have navigated)
  parts.push(`URL: ${page.url().slice(0, 80)}`)

  // Try to find similar text on page
  const textMatch = selector.match(/^text="(.+)"$/)
  if (textMatch) {
    try {
      const bodyText = await page.locator('body').innerText({ timeout: 3000 })
      const searchText = extractLastSegment(textMatch[1])
      if (bodyText.includes(searchText)) {
        parts.push(`"${searchText}" 存在於頁面文字中但 locator 找不到 (可能在 shadow DOM)`)
      } else {
        parts.push(`"${searchText}" 不在頁面文字中`)
      }
    } catch {
      parts.push('無法讀取頁面文字')
    }
  }

  return parts.join('; ')
}

// --- Locator resolution ---

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

function resolveLocator(page: Page, selector: string): Locator {
  return resolveLocatorForFrame(page, selector)
}

function resolveLocatorForFrame(frame: Page | Frame, selector: string): Locator {
  // role=button[name="Submit"]
  const roleMatch = selector.match(/^role=(\w+)\[name="(.+)"\]$/)
  if (roleMatch) {
    return frame.getByRole(roleMatch[1] as Parameters<Page['getByRole']>[0], { name: roleMatch[2] })
  }

  // Auto-detect bare role: combobox[name="搜尋"] → getByRole('combobox', { name: '搜尋' })
  const bareRoleMatch = selector.match(/^(\w+)\[name="(.+)"\]$/)
  if (bareRoleMatch && ARIA_ROLES.has(bareRoleMatch[1])) {
    return frame.getByRole(bareRoleMatch[1] as Parameters<Page['getByRole']>[0], { name: bareRoleMatch[2] })
  }

  // text="something" — with fallback for split-element text
  const textMatch = selector.match(/^text="(.+)"$/)
  if (textMatch) {
    const fullText = textMatch[1]
    const lastSegment = extractLastSegment(fullText)

    if (lastSegment !== fullText) {
      return frame.getByText(fullText).or(frame.getByText(lastSegment))
    }
    return frame.getByText(fullText)
  }

  // CSS selector fallback
  return frame.locator(selector)
}

/** Extract the last meaningful segment from combined text like "沒有帳號？註冊" → "註冊" */
function extractLastSegment(text: string): string {
  const parts = text.split(/[？?、，,/|\s]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : text
}
