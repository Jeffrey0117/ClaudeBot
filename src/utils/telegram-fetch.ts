/**
 * Proxy-aware fetch for downloading Telegram files (voice, images).
 * When TELEGRAM_PROXY is set, routes requests through undici ProxyAgent.
 * Provides user-friendly Chinese error messages.
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici'

let cachedDispatcher: ProxyAgent | null = null

function getDispatcher(proxyUrl: string): ProxyAgent {
  if (!cachedDispatcher) {
    cachedDispatcher = new ProxyAgent(proxyUrl)
  }
  return cachedDispatcher
}

export async function telegramFetch(
  url: string | URL,
  options?: { timeout?: number },
): Promise<Buffer> {
  const proxyUrl = process.env['TELEGRAM_PROXY']
  const signal = AbortSignal.timeout(options?.timeout ?? 30_000)

  try {
    const response = proxyUrl
      ? await undiciFetch(url, { dispatcher: getDispatcher(proxyUrl), signal })
      : await fetch(url.toString(), { signal })

    if (!response.ok) {
      throw new Error(`下載失敗 (HTTP ${response.status})`)
    }

    return Buffer.from(await response.arrayBuffer())
  } catch (err) {
    if (err instanceof Error) {
      // Already a user-friendly message from !response.ok
      if (err.message.startsWith('下載')) throw err

      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('下載語音檔逾時，請重試')
      }
      if (
        err.message.includes('fetch failed') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('UND_ERR')
      ) {
        const hint = proxyUrl ? '' : '（可設定 TELEGRAM_PROXY）'
        throw new Error(`網路連線失敗${hint}，請重試`)
      }
    }
    throw err
  }
}
