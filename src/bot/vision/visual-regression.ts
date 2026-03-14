/**
 * Visual regression — deploy-time screenshot comparison.
 *
 * Captures baseline screenshots before deploy, then compares
 * with post-deploy screenshots using Gemini Vision AI.
 */

import { getBrowser } from './browser-pool.js'
import { isSsrfBlocked } from './ssrf-guard.js'
import { compareScreenshots } from '../../ai/gemini-agent-vision.js'

const PAGE_TIMEOUT_MS = 30_000
const VIEWPORT = { width: 1280, height: 720 }

export interface VisualRegressionResult {
  readonly url: string
  readonly hasDiff: boolean
  readonly summary: string
  readonly error?: string
}

export interface RegressionConfig {
  readonly urls: readonly string[]
  readonly waitAfterDeploy?: number
}

/**
 * Capture baseline screenshots for a list of URLs.
 * Returns a Map of url → base64 screenshot data.
 */
export async function captureBaseline(urls: readonly string[]): Promise<Map<string, string>> {
  const baseline = new Map<string, string>()
  const browser = await getBrowser()

  for (const url of urls) {
    if (isSsrfBlocked(url)) continue

    const page = await browser.newPage({ viewport: VIEWPORT })
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
      const buffer = await page.screenshot({ fullPage: false })
      baseline.set(url, buffer.toString('base64'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[visual-regression] baseline capture failed for ${url}: ${msg}`)
    } finally {
      await page.close()
    }
  }

  return baseline
}

/**
 * Compare post-deploy screenshots with baseline using Gemini Vision.
 * Returns results for each URL.
 */
export async function compareWithBaseline(
  baseline: Map<string, string>,
  urls: readonly string[],
): Promise<readonly VisualRegressionResult[]> {
  const results: VisualRegressionResult[] = []
  const browser = await getBrowser()

  for (const url of urls) {
    const beforeBase64 = baseline.get(url)
    if (!beforeBase64) {
      results.push({
        url,
        hasDiff: false,
        summary: '無基準截圖可比對',
        error: 'no baseline',
      })
      continue
    }

    if (isSsrfBlocked(url)) {
      results.push({
        url,
        hasDiff: false,
        summary: 'SSRF blocked',
        error: 'ssrf',
      })
      continue
    }

    const page = await browser.newPage({ viewport: VIEWPORT })
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
      const afterBuffer = await page.screenshot({ fullPage: false })
      const afterBase64 = afterBuffer.toString('base64')

      const diff = await compareScreenshots(beforeBase64, afterBase64, url)
      results.push({ url, ...diff })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        url,
        hasDiff: false,
        summary: `截圖失敗: ${msg}`,
        error: msg,
      })
    } finally {
      await page.close()
    }
  }

  return results
}
