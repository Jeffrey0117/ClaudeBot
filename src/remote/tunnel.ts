/**
 * Auto-tunnel for relay server using localtunnel.
 *
 * When RELAY_TUNNEL=true, creates a public URL so remote agents
 * can connect from any network without port forwarding or ngrok.
 *
 * Priority: RELAY_PUBLIC_URL (manual) > localtunnel (auto) > LAN IP (fallback)
 *
 * The public URL is also written to data/.relay-url so non-main bot
 * processes (e.g. bot5) can read the tunnel URL for /pair display.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import localtunnel from 'localtunnel'

let publicUrl = ''
const sharedUrlFile = join(process.cwd(), 'data', '.relay-url')

/** When true, suppress reconnect on intentional close */
let shuttingDown = false

/** Current tunnel instance for graceful close */
let activeTunnel: Awaited<ReturnType<typeof localtunnel>> | null = null

/** Reconnect state */
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_DELAY_MS = 3_000
const MAX_DELAY_MS = 60_000

function writeSharedUrl(url: string): void {
  try {
    writeFileSync(sharedUrlFile, url, 'utf-8')
  } catch {
    // data/ dir may not exist in tests — ignore
  }
}

function clearSharedUrl(): void {
  try {
    unlinkSync(sharedUrlFile)
  } catch {
    // file may not exist — ignore
  }
}

export function getPublicRelayUrl(): string {
  if (publicUrl) return publicUrl
  // Fallback: read from shared file (for non-main bot processes)
  try {
    return readFileSync(sharedUrlFile, 'utf-8').trim()
  } catch {
    return ''
  }
}

export function setPublicRelayUrl(url: string): void {
  publicUrl = url
  writeSharedUrl(url)
}

/** Gracefully close tunnel and prevent reconnect. */
export function closeTunnel(): void {
  shuttingDown = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (activeTunnel) {
    activeTunnel.close()
    activeTunnel = null
  }
  publicUrl = ''
  clearSharedUrl()
}

function scheduleReconnect(port: number): void {
  if (shuttingDown) return
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[tunnel] Gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`)
    publicUrl = ''
    clearSharedUrl()
    return
  }

  const delay = Math.min(BASE_DELAY_MS * 2 ** reconnectAttempt, MAX_DELAY_MS)
  reconnectAttempt++
  console.error(`[tunnel] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startTunnel(port).catch((err) => {
      console.error(`[tunnel] Reconnect failed: ${err instanceof Error ? err.message : err}`)
      scheduleReconnect(port)
    })
  }, delay)
}

export async function startTunnel(port: number): Promise<string> {
  const tunnel = await localtunnel({ port })
  activeTunnel = tunnel

  // localtunnel gives https:// URL, convert to wss:// for WebSocket
  const wsUrl = tunnel.url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  publicUrl = wsUrl
  writeSharedUrl(wsUrl)

  // Successful connect — reset backoff counter
  reconnectAttempt = 0

  tunnel.on('close', () => {
    activeTunnel = null
    if (shuttingDown) return
    console.error('[tunnel] Tunnel closed unexpectedly, scheduling reconnect...')
    publicUrl = ''
    clearSharedUrl()
    scheduleReconnect(port)
  })

  tunnel.on('error', (err: Error) => {
    console.error('[tunnel] Tunnel error:', err.message)
    // Force reconnect on error — tunnel may be in zombie state (502)
    if (!shuttingDown && activeTunnel) {
      console.error('[tunnel] Error detected, forcing reconnect...')
      activeTunnel.close()
    }
  })

  console.log(`[tunnel] Public relay URL: ${wsUrl}`)
  return wsUrl
}
