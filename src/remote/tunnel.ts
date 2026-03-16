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

export async function startTunnel(port: number): Promise<string> {
  const tunnel = await localtunnel({ port })

  // localtunnel gives https:// URL, convert to wss:// for WebSocket
  const wsUrl = tunnel.url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  publicUrl = wsUrl
  writeSharedUrl(wsUrl)

  tunnel.on('close', () => {
    console.error('[tunnel] Tunnel closed unexpectedly, remote agents may disconnect')
    publicUrl = ''
    clearSharedUrl()
  })

  tunnel.on('error', (err: Error) => {
    console.error('[tunnel] Tunnel error:', err.message)
  })

  console.log(`[tunnel] Public relay URL: ${wsUrl}`)
  return wsUrl
}
