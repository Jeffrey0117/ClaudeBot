/**
 * Auto-tunnel for relay server using localtunnel.
 *
 * When RELAY_TUNNEL=true, creates a public URL so remote agents
 * can connect from any network without port forwarding or ngrok.
 *
 * Priority: RELAY_PUBLIC_URL (manual) > localtunnel (auto) > LAN IP (fallback)
 */

import localtunnel from 'localtunnel'

let publicUrl = ''

export function getPublicRelayUrl(): string {
  return publicUrl
}

export function setPublicRelayUrl(url: string): void {
  publicUrl = url
}

export async function startTunnel(port: number): Promise<string> {
  const tunnel = await localtunnel({ port })

  // localtunnel gives https:// URL, convert to wss:// for WebSocket
  const wsUrl = tunnel.url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  publicUrl = wsUrl

  tunnel.on('close', () => {
    console.error('[tunnel] Tunnel closed unexpectedly, remote agents may disconnect')
    publicUrl = ''
  })

  tunnel.on('error', (err: Error) => {
    console.error('[tunnel] Tunnel error:', err.message)
  })

  console.log(`[tunnel] Public relay URL: ${wsUrl}`)
  return wsUrl
}
