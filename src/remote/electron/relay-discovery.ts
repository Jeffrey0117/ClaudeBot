/**
 * Finding the relay's current address.
 *
 * The relay URL can change (tunnel rotation), so the desktop client looks it
 * up instead of trusting a saved one. Kept free of electron imports: the
 * caller passes in what it knows and how to remember what was found.
 */

export interface RelayDiscoveryInput {
  /** Base URL of the paste service that publishes the relay URL ('' = not configured). */
  readonly rawtxtBase: string
  /** Paste id that last held the relay URL, if any. */
  readonly savedPasteId?: string
  /** Explicit override for where to read the URL from. */
  readonly discoveryUrl?: string
  /** The relay URL currently in use, if any. */
  readonly currentRelayUrl: string
  /** Called with the paste id the URL was found in, so it can be saved. */
  readonly onPasteFound: (pasteId: string) => void
  readonly log: (message: string) => void
}

const isRelayUrl = (text: string | null): text is string =>
  !!text && (text.startsWith('wss://') || text.startsWith('ws://'))

/** Try fetching text from a URL with timeout. */
export async function fetchText(url: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    return (await res.text()).trim()
  } catch {
    return null
  }
}

/**
 * Discover the current relay URL by trying, in order:
 * 1. the newest relay-URL paste on the paste service
 * 2. the saved paste id (fast path when the list endpoint is down)
 * 3. the current tunnel's HTTP /relay-url (works if the tunnel is still alive)
 */
export async function discoverRelayUrl(input: RelayDiscoveryInput): Promise<string | null> {
  const { rawtxtBase } = input

  // 1. Scan rawtxt for the NEWEST wss:// paste — this is authoritative and
  //    handles URL rotation. The server keeps OLD pastes alive (with now-dead
  //    URLs), so a saved paste ID is unreliable: it would return a stale-but-
  //    valid-looking URL. The newest paste is the current relay.
  try {
    const listText = await fetchText(`${rawtxtBase}/api/pastes`, 10_000)
    if (listText) {
      const json = JSON.parse(listText) as { success?: boolean; data?: Array<{ id: string; sizeBytes: number }> }
      if (json.success && json.data) {
        // Pastes are sorted newest-first; relay URLs are typically 40-80 bytes
        const candidates = json.data.filter((p) => p.sizeBytes >= 30 && p.sizeBytes <= 120)
        for (const paste of candidates) {
          const raw = await fetchText(`${rawtxtBase}/${paste.id}/raw`, 5_000)
          if (isRelayUrl(raw)) {
            input.log(`Discovered relay URL from rawtxt scan (paste: ${paste.id})`)
            input.onPasteFound(paste.id)
            return raw.trim()
          }
        }
      }
    }
  } catch { /* scan is best-effort — fall through */ }

  // 2. Fallback: saved paste ID (fast path when the scan endpoint is down)
  if (input.savedPasteId) {
    const text = await fetchText(input.discoveryUrl || `${rawtxtBase}/${input.savedPasteId}/raw`)
    if (isRelayUrl(text)) return text.trim()
  }

  // 3. Fallback: current tunnel's HTTP /relay-url endpoint
  if (input.currentRelayUrl) {
    const httpUrl = input.currentRelayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const text = await fetchText(`${httpUrl}/relay-url`)
    if (isRelayUrl(text)) return text.trim()
  }

  return null
}
