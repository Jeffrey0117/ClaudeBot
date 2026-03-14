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

/** Get existing session for continuation mode. Returns null if no active session. */
export function getSession(chatId: number): BrowserSession | null {
  const entry = sessions.get(chatId)
  if (!entry) return null
  resetSessionIdle(chatId)
  return entry.session
}

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

export async function sessionScreenshot(session: BrowserSession, withGrid = false): Promise<string> {
  resetSessionIdle(session.chatId)
  if (withGrid) {
    // Inject coordinate grid overlay for click_xy accuracy
    await session.page.evaluate(`
      (function() {
        var existing = document.getElementById('__pw_grid');
        if (existing) existing.remove();
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = '__pw_grid';
        svg.style.cssText = 'position:fixed;top:0;left:0;width:1280px;height:720px;z-index:999999;pointer-events:none;';
        svg.setAttribute('viewBox', '0 0 1280 720');
        var html = '';
        for (var x = 0; x <= 1280; x += 100) {
          html += '<line x1="'+x+'" y1="0" x2="'+x+'" y2="720" stroke="rgba(255,0,0,0.25)" stroke-width="1"/>';
          html += '<text x="'+(x+2)+'" y="12" fill="red" font-size="10">'+x+'</text>';
        }
        for (var y = 0; y <= 720; y += 80) {
          html += '<line x1="0" y1="'+y+'" x2="1280" y2="'+y+'" stroke="rgba(255,0,0,0.25)" stroke-width="1"/>';
          html += '<text x="2" y="'+(y+12)+'" fill="red" font-size="10">'+y+'</text>';
        }
        svg.innerHTML = html;
        document.body.appendChild(svg);
      })()
    `).catch(() => { /* ignore if evaluate fails (closed shadow DOM page) */ })
  }
  const buffer = await session.page.screenshot({ fullPage: false })
  if (withGrid) {
    // Remove grid after screenshot
    await session.page.evaluate(`
      (function() { var g = document.getElementById('__pw_grid'); if (g) g.remove(); })()
    `).catch(() => {})
  }
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
      if (await tryDeepClick(session, textMatch[1])) return

      // Also try last segment (e.g. "沒有帳號？註冊" → "註冊")
      const lastSeg = extractLastSegment(textMatch[1])
      if (lastSeg !== textMatch[1]) {
        if (await tryDeepClick(session, lastSeg)) return
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
  const textMatch2 = selector.match(/^text="(.+)"$/)
  if (textMatch2) {
    if (await tryDeepClick(session, textMatch2[1])) return

    const lastSeg = extractLastSegment(textMatch2[1])
    if (lastSeg !== textMatch2[1]) {
      if (await tryDeepClick(session, lastSeg)) return
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

/** Try deep click, swallowing errors so the caller can fall through. */
async function tryDeepClick(session: BrowserSession, text: string): Promise<boolean> {
  try {
    return await sessionDeepClick(session, text)
  } catch {
    return false
  }
}

/**
 * Nuclear option: walk entire DOM including shadow roots via page.evaluate(),
 * find element by text content, and click it via JS.
 * Uses raw JS string to avoid function serialization issues (__name, etc.).
 * Returns true if found and clicked.
 */
export async function sessionDeepClick(session: BrowserSession, text: string): Promise<boolean> {
  resetSessionIdle(session.chatId)
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  try {
    return await session.page.evaluate(`
      (function() {
        var searchText = '${escaped}';
        var found = null;
        var allEls = document.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
          var txt = el.textContent || '';
          if (txt.trim().includes(searchText)) {
            var children = el.children;
            var isLeaf = true;
            for (var j = 0; j < children.length; j++) {
              if ((children[j].textContent || '').trim().includes(searchText)) {
                isLeaf = false;
                break;
              }
            }
            if (isLeaf) { found = el; break; }
          }
        }
        if (!found) {
          var links = document.querySelectorAll('a, button, [role="button"], [onclick]');
          for (var k = 0; k < links.length; k++) {
            if ((links[k].textContent || '').trim().includes(searchText)) {
              found = links[k];
              break;
            }
          }
        }
        if (found) {
          found.scrollIntoView({ block: 'center' });
          found.click();
          return true;
        }
        return false;
      })()
    `) as boolean
  } catch {
    return false
  }
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
