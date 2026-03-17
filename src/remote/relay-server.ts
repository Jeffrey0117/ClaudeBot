/**
 * WebSocket relay server (A-side).
 *
 * Accepts two types of connections:
 * 1. Remote agents (N-side) — register with a pairing code
 * 2. MCP proxies — connect with a code to reach the paired agent
 *
 * The relay forwards tool_call/tool_result messages between proxy and agent.
 */

import { WebSocketServer, type WebSocket } from 'ws'
import {
  findByCode,
  markConnected,
  markDisconnected,
  resetAllConnectedFlags,
} from './pairing-store.js'
import type {
  RelayInbound,
  AgentRegistered,
  ProxyConnected,
  RelayError,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
} from './protocol.js'

interface PairedAgent {
  readonly ws: WebSocket
  readonly code: string
  readonly connectedAt: number
}

interface PairedProxy {
  readonly ws: WebSocket
  readonly code: string
}

/** Active agents keyed by pairing code */
const agents = new Map<string, PairedAgent>()

/** Active proxies keyed by pairing code */
const proxies = new Map<string, Set<PairedProxy>>()

/** Route tool results to the proxy that sent the request: code → (requestId → proxy ws) */
const requestOrigins = new Map<string, Map<number, WebSocket>>()

/** Rate limiting: IP → { attempts, lastAttempt } */
const rateLimits = new Map<string, { attempts: number; resetAt: number }>()
const MAX_ATTEMPTS_PER_MINUTE = 5

let relayPort = 0

export function getRelayPort(): number {
  return relayPort
}

function send(ws: WebSocket, msg: AgentRegistered | ProxyConnected | RelayError | ToolCallRequest | ToolCallResult | ToolCallError): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimits.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { attempts: 1, resetAt: now + 60_000 })
    return false
  }
  entry.attempts++
  return entry.attempts > MAX_ATTEMPTS_PER_MINUTE
}

function handleAgentRegister(ws: WebSocket, code: string, ip: string): void {
  const session = findByCode(code)
  if (!session) {
    // Only rate-limit INVALID codes — valid reconnects should always work
    if (isRateLimited(ip)) {
      send(ws, { type: 'error', error: 'Too many attempts. Try again later.' })
      ws.close()
      return
    }
    send(ws, { type: 'error', error: 'Invalid pairing code' })
    ws.close()
    return
  }

  // Disconnect previous agent for this code if any
  const prev = agents.get(code)
  if (prev && prev.ws !== ws) {
    prev.ws.close()
  }

  agents.set(code, { ws, code, connectedAt: Date.now() })

  markConnected(code, 'remote agent')

  send(ws, { type: 'agent_registered' })
  console.log(`[relay] Agent registered: code=${code} from=${ip}`)
}

function handleProxyConnect(ws: WebSocket, code: string): void {
  const agent = agents.get(code)
  if (!agent || agent.ws.readyState !== agent.ws.OPEN) {
    send(ws, { type: 'error', error: 'No agent connected for this code' })
    ws.close()
    return
  }

  const proxyEntry: PairedProxy = { ws, code }
  if (!proxies.has(code)) {
    proxies.set(code, new Set())
  }
  proxies.get(code)!.add(proxyEntry)

  // Ensure request origin tracking map exists
  if (!requestOrigins.has(code)) {
    requestOrigins.set(code, new Map())
  }

  send(ws, { type: 'proxy_connected' })
  console.log(`[relay] Proxy connected: code=${code}`)

  // Forward messages from proxy → agent (with origin tracking)
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as RelayInbound
      if (msg.type === 'tool_call') {
        const origins = requestOrigins.get(code)
        if (origins) {
          origins.set((msg as ToolCallRequest).id, ws)
        }
        send(agent.ws, msg)
      }
    } catch {
      // ignore malformed
    }
  })

  ws.on('close', () => {
    proxies.get(code)?.delete(proxyEntry)
  })
}

function handleAgentMessage(_ws: WebSocket, code: string, msg: RelayInbound): void {
  // Route tool_result / tool_error to the ORIGINATING proxy only
  if (msg.type === 'tool_result' || msg.type === 'tool_error') {
    // Check if this is a bot-initiated call first
    if (tryRouteBotResult(msg as ToolCallResult | ToolCallError)) return

    const origins = requestOrigins.get(code)
    if (origins) {
      const originProxy = origins.get(msg.id)
      if (originProxy) {
        send(originProxy, msg)
        origins.delete(msg.id)
      }
    }
  }
}

/** Next request ID for bot-initiated tool calls */
let nextBotRequestId = 900_000

/** Pending bot-initiated tool call resolvers: requestId → resolve */
const botPendingCalls = new Map<number, { resolve: (result: string) => void; timer: ReturnType<typeof setTimeout> }>()

/**
 * Call a tool on a remote agent directly from the bot (not via MCP proxy).
 * Used for /projects, /chat, etc. on remote-only users.
 */
export function callAgentTool(
  code: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const agent = agents.get(code)
    if (!agent || agent.ws.readyState !== agent.ws.OPEN) {
      reject(new Error('Agent not connected'))
      return
    }

    const id = nextBotRequestId++
    const timer = setTimeout(() => {
      botPendingCalls.delete(id)
      reject(new Error('Agent tool call timeout'))
    }, timeoutMs)

    botPendingCalls.set(id, { resolve, timer })

    send(agent.ws, { type: 'tool_call', id, tool, args })
  })
}

/** Route bot-initiated tool results (called from handleAgentMessage) */
function tryRouteBotResult(msg: ToolCallResult | ToolCallError): boolean {
  const pending = botPendingCalls.get(msg.id)
  if (!pending) return false
  clearTimeout(pending.timer)
  botPendingCalls.delete(msg.id)
  if (msg.type === 'tool_result') {
    pending.resolve(msg.result)
  } else {
    pending.resolve(`Error: ${msg.error}`)
  }
  return true
}

export function startRelayServer(port: number): void {
  relayPort = port

  // Clear stale connected flags from previous run — process may have
  // been killed without graceful close, leaving pairings.json lying.
  // Agents will reconnect and markConnected() restores them.
  const cleared = resetAllConnectedFlags()
  if (cleared > 0) {
    console.log(`[relay] Cleared ${cleared} stale connected flag(s) from previous run`)
  }

  const wss = new WebSocketServer({ port })

  // Ping all connected agents every 25s to keep WebSocket alive
  // (Cloudflare Tunnel, NAT routers, and proxies drop idle connections)
  const PING_INTERVAL_MS = 25_000
  setInterval(() => {
    for (const [, agent] of agents) {
      if (agent.ws.readyState === agent.ws.OPEN) {
        agent.ws.ping()
      }
    }
  }, PING_INTERVAL_MS)

  wss.on('connection', (ws, req) => {
    let role: 'unknown' | 'agent' | 'proxy' = 'unknown'
    let assignedCode = ''
    const ip = req.socket.remoteAddress ?? 'unknown'

    ws.on('message', (raw) => {
      let msg: RelayInbound
      try {
        msg = JSON.parse(raw.toString()) as RelayInbound
      } catch {
        send(ws, { type: 'error', error: 'Invalid JSON' })
        return
      }

      // First message determines role
      if (role === 'unknown') {
        if (msg.type === 'agent_register') {
          role = 'agent'
          assignedCode = msg.code
          handleAgentRegister(ws, msg.code, ip)
          return
        }
        if (msg.type === 'proxy_connect') {
          role = 'proxy'
          assignedCode = msg.code
          handleProxyConnect(ws, msg.code)
          return
        }
        send(ws, { type: 'error', error: 'First message must be agent_register or proxy_connect' })
        ws.close()
        return
      }

      // Subsequent messages — proxy handled by its own listener
      if (role === 'proxy') return

      if (role === 'agent') {
        handleAgentMessage(ws, assignedCode, msg)
      }
    })

    ws.on('close', () => {
      if (role === 'agent' && assignedCode) {
        const current = agents.get(assignedCode)
        if (current?.ws === ws) {
          agents.delete(assignedCode)
          markDisconnected(assignedCode)

          // Reject all pending proxy requests for this agent
          const origins = requestOrigins.get(assignedCode)
          if (origins) {
            for (const [id, proxyWs] of origins) {
              send(proxyWs, { type: 'tool_error', id, error: 'Agent disconnected' })
            }
            requestOrigins.delete(assignedCode)
          }

          // Reject all pending bot-initiated calls for this agent
          for (const [id, pending] of botPendingCalls) {
            clearTimeout(pending.timer)
            pending.resolve('Error: Agent disconnected')
            botPendingCalls.delete(id)
          }

          console.log(`[relay] Agent disconnected: code=${assignedCode}`)
        }
      }
    })

    ws.on('error', (err) => {
      console.error(`[relay] WebSocket error (${role}):`, err.message)
    })
  })

  // Periodic cleanup of stale rate limit entries (every 5 min)
  setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetAt) {
        rateLimits.delete(ip)
      }
    }
  }, 5 * 60_000)

  console.log(`[relay] Server listening on port ${port}`)
}
