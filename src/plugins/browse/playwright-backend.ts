import { chromium, type Browser, type Page } from 'playwright'
import type { BrowserBackend, PageInfo, PageLink, PageInput } from './browser-backend.js'

const MAX_TEXT_LENGTH = 2000
const VIEWPORT = { width: 1280, height: 720 }
const TIMEOUT_MS = 30_000

async function extractPageInfo(page: Page): Promise<PageInfo> {
  const url = page.url()
  const title = await page.title()

  const text = await page.evaluate(() => {
    const body = document.body
    if (!body) return ''
    return body.innerText || ''
  })

  const links: PageLink[] = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    return anchors
      .map((a) => ({
        label: (a.textContent || '').trim().slice(0, 100),
        url: (a as HTMLAnchorElement).href,
      }))
      .filter((l) => l.label && l.url.startsWith('http'))
      .slice(0, 30)
  })

  const inputs: PageInput[] = await page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll('input, textarea, select')
    )
    return elements
      .map((el, i) => {
        const input = el as HTMLInputElement
        return {
          ref: String(i),
          type: input.type || el.tagName.toLowerCase(),
          placeholder: input.placeholder || input.name || '',
        }
      })
      .slice(0, 20)
  })

  return {
    url,
    title: title || url,
    text: text.slice(0, MAX_TEXT_LENGTH),
    links,
    inputs,
  }
}

export function createPlaywrightBackend(): BrowserBackend {
  let browser: Browser | null = null
  let page: Page | null = null

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page
    if (!browser) {
      browser = await chromium.launch()
    }
    page = await browser.newPage({ viewport: VIEWPORT })
    return page
  }

  return {
    async navigate(url: string): Promise<PageInfo> {
      const p = await ensurePage()
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
      return extractPageInfo(p)
    },

    async click(ref: string): Promise<PageInfo> {
      const p = await ensurePage()
      const index = parseInt(ref, 10)
      if (isNaN(index) || index < 0) {
        throw new Error('ref 必須是非負整數')
      }
      await p.evaluate((idx) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'))
          .filter((a) => {
            const label = (a.textContent || '').trim()
            const href = (a as HTMLAnchorElement).href
            return label && href.startsWith('http')
          })
        const target = anchors[idx]
        if (target) (target as HTMLElement).click()
      }, index)
      await p.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS }).catch(() => {})
      return extractPageInfo(p)
    },

    async type(ref: string, text: string): Promise<PageInfo> {
      const p = await ensurePage()
      const index = parseInt(ref, 10)
      if (isNaN(index) || index < 0) {
        throw new Error('ref 必須是非負整數')
      }
      await p.evaluate(({ idx, value }) => {
        const elements = Array.from(
          document.querySelectorAll('input, textarea, select')
        )
        const target = elements[idx] as HTMLInputElement | undefined
        if (target) {
          target.focus()
          target.value = value
          target.dispatchEvent(new Event('input', { bubbles: true }))
          target.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, { idx: index, value: text })
      return extractPageInfo(p)
    },

    async screenshot(): Promise<Buffer> {
      const p = await ensurePage()
      return p.screenshot({ type: 'png' }) as Promise<Buffer>
    },

    async getText(): Promise<string> {
      const p = await ensurePage()
      const text = await p.evaluate(() => document.body?.innerText || '')
      return text.slice(0, MAX_TEXT_LENGTH)
    },

    async back(): Promise<PageInfo> {
      const p = await ensurePage()
      await p.goBack({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
        .catch(() => {})
      return extractPageInfo(p)
    },

    async cleanup(): Promise<void> {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {})
        page = null
      }
      if (browser) {
        await browser.close().catch(() => {})
        browser = null
      }
    },
  }
}
