/**
 * Auto-tunnel for relay server.
 *
 * When RELAY_TUNNEL=true, creates a public URL so remote agents
 * can connect from any network without port forwarding.
 *
 * Priority: RELAY_PUBLIC_URL (manual) > cloudflared (auto) > localtunnel (fallback) > LAN IP
 *
 * The public URL is also written to data/.relay-url so non-main bot
 * processes (e.g. bot5) can read the tunnel URL for /pair display.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

let publicUrl = ''
const sharedUrlFile = join(process.cwd(), 'data', '.relay-url')

/** When true, suppress reconnect on intentional close */
let shuttingDown = false

/** Which tunnel backend is active */
let activeBackend: 'cloudflared' | 'localtunnel' | null = null

/** Cloudflared child process */
let cfProcess: ChildProcess | null = null

/** Localtunnel instance */
let ltTunnel: { close: () => void; url: string; on: (event: string, cb: (...args: unknown[]) => void) => void } | null = null

/** Reconnect state */
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RECONNECT_ATTEMPTS = 15
const BASE_DELAY_MS = 3_000
const MAX_DELAY_MS = 60_000

/** Port being tunneled (saved for reconnect) */
let tunnelPort = 0

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
  killActiveBackend()
  publicUrl = ''
  clearSharedUrl()
}

function killActiveBackend(): void {
  if (cfProcess) {
    cfProcess.kill('SIGTERM')
    cfProcess = null
  }
  if (ltTunnel) {
    ltTunnel.close()
    ltTunnel = null
  }
  activeBackend = null
}

function setTunnelUrl(url: string): void {
  // Convert https:// to wss:// for WebSocket
  const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  publicUrl = wsUrl
  writeSharedUrl(wsUrl)
  reconnectAttempt = 0
  console.log(`[tunnel] Public relay URL: ${wsUrl}`)
}

function scheduleReconnect(): void {
  if (shuttingDown || tunnelPort === 0) return
  // Clear any existing reconnect timer before scheduling new one
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
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
    startTunnel(tunnelPort).catch((err) => {
      console.error(`[tunnel] Reconnect failed: ${err instanceof Error ? err.message : err}`)
      scheduleReconnect()
    })
  }, delay)
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel (primary — more stable)
// ---------------------------------------------------------------------------

function findCloudflared(): string {
  // Check local binary first (project root), then PATH
  const localBin = join(process.cwd(), 'cloudflared.exe')
  if (existsSync(localBin)) return localBin
  return 'cloudflared'
}

function startCloudflared(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = findCloudflared()
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    cfProcess = proc
    activeBackend = 'cloudflared'
    let resolved = false
    let gotUrl = false

    // cloudflared prints the URL in stderr
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/

    function handleOutput(data: Buffer): void {
      const line = data.toString()
      if (resolved) return
      const match = line.match(urlRegex)
      if (match) {
        resolved = true
        gotUrl = true
        resolve(match[0])
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        cfProcess = null
        activeBackend = null
        reject(err)
      }
    })

    proc.on('close', (code) => {
      cfProcess = null
      if (!resolved) {
        resolved = true
        activeBackend = null
        reject(new Error(`cloudflared exited with code ${code}`))
        return
      }
      // Only reconnect if cloudflared was actually working (got a URL)
      // If it failed with ENOENT, the fallback to localtunnel handles it
      if (!gotUrl) return
      if (!shuttingDown) {
        console.error(`[tunnel] cloudflared process exited (code ${code}), scheduling reconnect...`)
        publicUrl = ''
        clearSharedUrl()
        scheduleReconnect()
      }
    })

    // Timeout: if no URL parsed within 15s, reject and clean up
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.stdout?.removeAllListeners()
        proc.stderr?.removeAllListeners()
        proc.removeAllListeners()
        proc.kill('SIGTERM')
        cfProcess = null
        activeBackend = null
        reject(new Error('cloudflared timeout — no URL received within 15s'))
      }
    }, 15_000)
  })
}

// ---------------------------------------------------------------------------
// Localtunnel (fallback)
// ---------------------------------------------------------------------------

async function startLocaltunnel(port: number): Promise<string> {
  const localtunnel = (await import('localtunnel')).default
  const tunnel = await localtunnel({ port })
  ltTunnel = tunnel
  activeBackend = 'localtunnel'

  tunnel.on('close', () => {
    ltTunnel = null
    if (shuttingDown) return
    console.error('[tunnel] localtunnel closed unexpectedly, scheduling reconnect...')
    publicUrl = ''
    clearSharedUrl()
    scheduleReconnect()
  })

  tunnel.on('error', (err: Error) => {
    console.error('[tunnel] localtunnel error:', err.message)
    // Force reconnect on error — tunnel may be in zombie state (502)
    if (!shuttingDown && ltTunnel) {
      console.error('[tunnel] Error detected, forcing reconnect...')
      ltTunnel.close()
    }
  })

  return tunnel.url
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startTunnel(port: number): Promise<string> {
  tunnelPort = port
  killActiveBackend()

  // Try cloudflared first (more stable)
  try {
    const url = await startCloudflared(port)
    setTunnelUrl(url)
    console.log('[tunnel] Using cloudflared (Cloudflare Tunnel)')
    return publicUrl
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // ENOENT = binary not found, other errors = binary exists but failed
    if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not recognized')) {
      console.log('[tunnel] cloudflared not installed, falling back to localtunnel')
    } else {
      console.error(`[tunnel] cloudflared failed: ${msg}, falling back to localtunnel`)
    }
  }

  // Fallback to localtunnel
  const url = await startLocaltunnel(port)
  setTunnelUrl(url)
  console.log('[tunnel] Using localtunnel (fallback)')
  return publicUrl
}
