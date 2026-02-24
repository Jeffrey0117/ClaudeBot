import type { BrowserBackend, PageInfo, PageLink, PageInput } from './browser-backend.js'

const MAX_TEXT_LENGTH = 2000

interface PinchtabSnapshot {
  readonly role: string
  readonly content: string
}

interface PinchtabActionResult {
  readonly success: boolean
  readonly message?: string
}

function parsePinchtabUrl(): string {
  return process.env['PINCHTAB_URL'] || 'http://localhost:9867'
}

async function pinchtabFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = parsePinchtabUrl()
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!response.ok) {
    throw new Error(`Pinchtab ${path} failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function pinchtabFetchBuffer(path: string): Promise<Buffer> {
  const baseUrl = parsePinchtabUrl()
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) {
    throw new Error(`Pinchtab ${path} failed: ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

function parseLinksFromSnapshot(content: string): readonly PageLink[] {
  const links: PageLink[] = []
  const linkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g
  let match
  while ((match = linkRegex.exec(content)) !== null) {
    links.push({ label: match[1] || match[2], url: match[2] })
  }
  return links
}

function parseInputsFromSnapshot(content: string): readonly PageInput[] {
  const inputs: PageInput[] = []
  const inputRegex = /\[ref=(\d+)\]\s*(?:input|textarea)\s*(?:type="([^"]*)")?\s*(?:placeholder="([^"]*)")?/gi
  let match
  while ((match = inputRegex.exec(content)) !== null) {
    inputs.push({
      ref: match[1],
      type: match[2] || 'text',
      placeholder: match[3] || '',
    })
  }
  return inputs
}

async function getPageInfo(currentUrl: string): Promise<PageInfo> {
  const [textResult, snapshotResult] = await Promise.all([
    pinchtabFetch<{ text: string }>('/text'),
    pinchtabFetch<readonly PinchtabSnapshot[]>('/snapshot?filter=interactive')
      .catch(() => [] as readonly PinchtabSnapshot[]),
  ])

  const snapshotContent = snapshotResult
    .map((s) => s.content)
    .join('\n')

  return {
    url: currentUrl,
    title: textResult.text.split('\n')[0]?.trim() || currentUrl,
    text: textResult.text.slice(0, MAX_TEXT_LENGTH),
    links: parseLinksFromSnapshot(snapshotContent),
    inputs: parseInputsFromSnapshot(snapshotContent),
  }
}

export function createPinchtabBackend(): BrowserBackend {
  const urlHistory: string[] = []

  return {
    async navigate(url: string): Promise<PageInfo> {
      await pinchtabFetch('/navigate', {
        method: 'POST',
        body: JSON.stringify({ url }),
      })
      urlHistory.push(url)
      return getPageInfo(url)
    },

    async click(ref: string): Promise<PageInfo> {
      await pinchtabFetch<PinchtabActionResult>('/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'click', ref }),
      })
      const currentUrl = urlHistory[urlHistory.length - 1] || ''
      return getPageInfo(currentUrl)
    },

    async type(ref: string, text: string): Promise<PageInfo> {
      await pinchtabFetch<PinchtabActionResult>('/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'type', ref, text }),
      })
      const currentUrl = urlHistory[urlHistory.length - 1] || ''
      return getPageInfo(currentUrl)
    },

    async screenshot(): Promise<Buffer> {
      return pinchtabFetchBuffer('/screenshot')
    },

    async getText(): Promise<string> {
      const result = await pinchtabFetch<{ text: string }>('/text')
      return result.text.slice(0, MAX_TEXT_LENGTH)
    },

    async back(): Promise<PageInfo> {
      await pinchtabFetch('/navigate', {
        method: 'POST',
        body: JSON.stringify({ action: 'back' }),
      })
      if (urlHistory.length > 1) urlHistory.pop()
      const currentUrl = urlHistory[urlHistory.length - 1] || ''
      return getPageInfo(currentUrl)
    },

    async cleanup(): Promise<void> {
      // Pinchtab sessions are server-managed, no cleanup needed
    },
  }
}

export async function isPinchtabAvailable(): Promise<boolean> {
  try {
    const baseUrl = parsePinchtabUrl()
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}
