#!/usr/bin/env node
/**
 * ClaudeBot Remote Agent — runs on the friend's computer (N-side).
 *
 * Connects OUTBOUND to the ClaudeBot relay server (A-side).
 * Executes filesystem / shell operations locally on behalf of Claude.
 *
 * Usage:
 *   npx tsx src/remote/agent.ts <relay-url> <pairing-code> [base-dir]
 *   npx tsx src/remote/agent.ts ws://your-server.com:9877 482913
 *   npx tsx src/remote/agent.ts ws://your-server.com:9877 482913 /path/to/project
 */

import { WebSocket } from 'ws'
import { resolve } from 'node:path'
import { createToolDispatcher } from './tool-handlers.js'
import type {
  AgentRegister,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
} from './protocol.js'

// --- Config ---

const RELAY_URL = process.argv[2]
const PAIRING_CODE = process.argv[3]
const BASE_DIR = resolve(process.argv[4] || process.cwd())
const RECONNECT_DELAY_MS = 3_000

if (!RELAY_URL || !PAIRING_CODE) {
  console.error('Usage: npx tsx src/remote/agent.ts <relay-url> <code> [base-dir]')
  console.error('Example: npx tsx src/remote/agent.ts ws://1.2.3.4:9877 482913')
  process.exit(1)
}

const toolDispatcher = createToolDispatcher(BASE_DIR)

// --- WebSocket connection ---

let ws: WebSocket | null = null
let shouldReconnect = true

const PING_TIMEOUT_MS = 60_000  // If no ping from relay for 60s, assume dead

function connect(): void {
  console.log(`Connecting to ${RELAY_URL}...`)
  const socket = new WebSocket(RELAY_URL)
  let lastPing = Date.now()

  // Monitor relay liveness — if no ping received for 60s, connection is likely dead
  // (zombie TCP from tunnel/NAT drop). Force close to trigger reconnect.
  const livenessCheck = setInterval(() => {
    if (Date.now() - lastPing > PING_TIMEOUT_MS) {
      console.log('⚠️ No ping from relay for 60s — forcing reconnect')
      clearInterval(livenessCheck)
      socket.terminate()
    }
  }, 10_000)

  socket.on('ping', () => {
    lastPing = Date.now()
  })

  socket.on('open', () => {
    lastPing = Date.now()
    const msg: AgentRegister = { type: 'agent_register', code: PAIRING_CODE }
    socket.send(JSON.stringify(msg))
  })

  socket.on('message', async (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'agent_registered') {
      ws = socket
      console.log('✅ Connected and paired!')
      console.log('')
      console.log(`Working directory: ${BASE_DIR}`)
      console.log('Waiting for Claude commands...')
      console.log('')
      return
    }

    if (msg.type === 'error') {
      console.error(`❌ Relay error: ${msg.error}`)
      socket.close()
      return
    }

    if (msg.type === 'tool_call') {
      const req = msg as unknown as ToolCallRequest
      const toolShort = req.tool.replace('remote_', '')
      const argsPreview = Object.values(req.args).map(String).join(', ').slice(0, 60)
      console.log(`🔧 ${toolShort}(${argsPreview})`)

      try {
        const result = await toolDispatcher.dispatch(req.tool, req.args)
        const resp: ToolCallResult = { id: req.id, type: 'tool_result', result }
        socket.send(JSON.stringify(resp))
        console.log(`   ✓ done (${result.length} chars)`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const resp: ToolCallError = { id: req.id, type: 'tool_error', error }
        socket.send(JSON.stringify(resp))
        console.log(`   ✗ error: ${error}`)
      }
    }
  })

  socket.on('close', () => {
    ws = null
    clearInterval(livenessCheck)
    if (shouldReconnect) {
      console.log(`🔌 Disconnected. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
      setTimeout(connect, RECONNECT_DELAY_MS)
    }
  })

  socket.on('error', (err) => {
    console.error(`Connection error: ${err.message}`)
  })
}

// --- Startup ---

console.log('')
console.log('╔══════════════════════════════════════╗')
console.log('║     ClaudeBot Remote Agent           ║')
console.log('╠══════════════════════════════════════╣')
console.log(`║  Server: ${RELAY_URL.padEnd(28)}║`)
console.log(`║  Code:   ${PAIRING_CODE.padEnd(28)}║`)
console.log(`║  Dir:    ${(BASE_DIR.length > 28 ? '...' + BASE_DIR.slice(-25) : BASE_DIR).padEnd(28)}║`)
console.log('╚══════════════════════════════════════╝')
console.log('')

connect()

// --- Graceful shutdown ---

function shutdown(): void {
  shouldReconnect = false
  if (ws) ws.close()
  console.log('\nShutting down.')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
