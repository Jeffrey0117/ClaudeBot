/**
 * Relay tunnel — expose relay WS port via public URL.
 *
 * Supports:
 * 1. RELAY_TUNNEL=true  → auto-spawn `cloudflared tunnel` (must be installed)
 * 2. RELAY_TUNNEL=<url> → user-provided public URL (any tunnel provider)
 * 3. RELAY_TUNNEL=''    → disabled (default, local-only)
 */

import { spawn, type ChildProcess } from 'node:child_process'

let publicUrl = ''
let tunnelProcess: ChildProcess | null = null

export function getTunnelUrl(): string {
  return publicUrl
}

/**
 * Start a tunnel for the relay server port.
 * Resolves with the public URL, or '' if tunnel is disabled/failed.
 */
export async function startRelayTunnel(
  port: number,
  tunnelConfig: string,
): Promise<string> {
  if (!tunnelConfig) return ''

  // User provided a URL directly — just use it
  if (tunnelConfig.startsWith('http://') || tunnelConfig.startsWith('https://')) {
    publicUrl = tunnelConfig.replace(/\/$/, '')
    console.log(`[tunnel] Using user-provided URL: ${publicUrl}`)
    return publicUrl
  }

  // Auto mode — spawn cloudflared quick tunnel
  if (tunnelConfig === 'true') {
    return startCloudflaredTunnel(port)
  }

  console.error(`[tunnel] Unknown RELAY_TUNNEL value: "${tunnelConfig}". Use "true" or a URL.`)
  return ''
}

function startCloudflaredTunnel(port: number): Promise<string> {
  return new Promise((resolve) => {
    const args = ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate']
    const child = spawn('cloudflared', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    tunnelProcess = child
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        console.error('[tunnel] cloudflared timed out after 15s')
        resolve('')
      }
    }, 15_000)

    // cloudflared prints the URL to stderr
    const handleOutput = (data: Buffer): void => {
      const line = data.toString()
      // Match the trycloudflare.com URL from output
      const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        publicUrl = match[1]
        console.log(`[tunnel] Public URL: ${publicUrl}`)
        resolve(publicUrl)
      }
    }

    child.stderr?.on('data', handleOutput)
    child.stdout?.on('data', handleOutput)

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error('[tunnel] cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
        } else {
          console.error('[tunnel] cloudflared error:', err.message)
        }
        resolve('')
      }
    })

    child.on('exit', (code) => {
      tunnelProcess = null
      publicUrl = ''
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        console.error(`[tunnel] cloudflared exited with code ${code}`)
        resolve('')
      } else if (code !== null && code !== 0) {
        console.error(`[tunnel] cloudflared exited unexpectedly (code ${code})`)
      }
    })
  })
}

export function stopRelayTunnel(): void {
  if (tunnelProcess) {
    tunnelProcess.kill()
    tunnelProcess = null
    publicUrl = ''
  }
}
