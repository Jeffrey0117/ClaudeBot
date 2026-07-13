#!/usr/bin/env node
/**
 * ClaudeBot "join BAT" client.
 *
 * Redeems a one-time pairing code at a ClaudeBot relay for a Better Agent
 * Terminal (BAT) remote credential pack, and persists it to data/bat-remote.json
 * so the local `bat-remote` AI backend can connect without hand-copying the
 * token/fingerprint.
 *
 * Usage:
 *   npx tsx src/remote/join-bat.ts <relay-url> <pairing-code>
 *   npx tsx src/remote/join-bat.ts ws://your-host:9877 482913
 *
 * Get the code from the host's Telegram: `/pair bat`.
 */

import { WebSocket } from 'ws'
import { writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'
import type { BatCredentialsRequest, BatCredentials, RelayError } from './protocol.js'

const RELAY_URL = process.argv[2]
const CODE = process.argv[3]

if (!RELAY_URL || !CODE) {
  console.error('Usage: npx tsx src/remote/join-bat.ts <relay-url> <pairing-code>')
  console.error('Example: npx tsx src/remote/join-bat.ts ws://1.2.3.4:9877 482913')
  process.exit(1)
}

const STORE_PATH = path.resolve('data', 'bat-remote.json')
const CONNECT_TIMEOUT_MS = 15_000

/** Persist the credential pack with best-effort restrictive permissions. */
function persist(pack: BatCredentials): void {
  mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const data = {
    url: pack.url,
    token: pack.token,
    fingerprint: pack.fingerprint,
    ...(pack.cwdDefault ? { cwd: pack.cwdDefault } : {}),
  }
  const tmp = `${STORE_PATH}.tmp`
  // mode 0o600 on POSIX; a no-op-ish on Windows but harmless.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, STORE_PATH)
  try { chmodSync(STORE_PATH, 0o600) } catch { /* Windows: ignore */ }
}

function main(): void {
  console.log(`Connecting to relay ${RELAY_URL} ...`)
  const ws = new WebSocket(RELAY_URL)
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    console.error('❌ Timed out waiting for the relay response.')
    try { ws.terminate() } catch { /* ignore */ }
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  const finish = (code: number): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { ws.close() } catch { /* ignore */ }
    process.exit(code)
  }

  ws.on('open', () => {
    const req: BatCredentialsRequest = { type: 'bat_credentials_request', code: CODE }
    ws.send(JSON.stringify(req))
  })

  ws.on('message', (raw) => {
    let msg: BatCredentials | RelayError | { type?: string }
    try {
      msg = JSON.parse(raw.toString()) as BatCredentials | RelayError
    } catch {
      return
    }
    if (msg.type === 'bat_credentials') {
      const pack = msg as BatCredentials
      try {
        persist(pack)
      } catch (err) {
        console.error(`❌ Failed to write ${STORE_PATH}: ${err instanceof Error ? err.message : String(err)}`)
        finish(1)
        return
      }
      console.log('✅ BAT credentials saved.')
      console.log(`   file: ${STORE_PATH}`)
      console.log(`   host: ${pack.url}`)
      if (pack.cwdDefault) console.log(`   cwd:  ${pack.cwdDefault}`)
      console.log('')
      console.log('The bat-remote backend will now use this automatically (no env vars needed).')
      finish(0)
      return
    }
    if (msg.type === 'error') {
      console.error(`❌ Relay error: ${(msg as RelayError).error}`)
      finish(1)
      return
    }
  })

  ws.on('error', (err) => {
    if (settled) return
    console.error(`❌ Connection error: ${err.message}`)
    finish(1)
  })

  ws.on('close', () => {
    if (settled) return
    console.error('❌ Relay closed the connection before sending credentials.')
    finish(1)
  })
}

main()
