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
import { env } from '../config/env.js'
import { startTunnel, setPublicRelayUrl, getPublicRelayUrl } from './tunnel.js'
import type {
  RelayInbound,
  AgentRegistered,
  ProxyConnected,
  RelayError,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
  AgentShutdown,
  ElectronChatRegister,
  ElectronChatRegistered,
  ChatMessage,
  ChatCallback,
} from './protocol.js'
import { getOrCreateVirtualChat, isCodeUsedByVirtualChat } from './virtual-chat-store.js'
import { registerVirtualChat, unregisterVirtualChat } from './telegram-proxy.js'
import { handleElectronChatMessage, handleElectronChatCallback } from './electron-chat-bridge.js'
import { setUserProject } from '../bot/state.js'

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

/** Agents that sent a graceful shutdown message: code → reason */
const gracefulShutdowns = new Map<string, string>()

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

  // Allow registration if code is in pairing-store OR used by an Electron virtual chat.
  // Electron chat embeds an agent, but its code can become stale when /pair re-runs
  // (pairing-store deletes old codes). The virtual-chat-store retains the code.
  if (!session && !isCodeUsedByVirtualChat(code)) {
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

  // Only mark connected in pairing-store if the code exists there
  if (session) {
    markConnected(code, 'remote agent')
  }

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
  // Graceful shutdown notification from agent
  if (msg.type === 'agent_shutdown') {
    const reason = (msg as AgentShutdown).reason || '手動關閉'
    gracefulShutdowns.set(code, reason)
    console.log(`[relay] Agent graceful shutdown: code=${code} reason=${reason}`)
    return
  }

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
function callAgentToolOnce(
  code: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
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

/** Retry wrapper: retries once on timeout, does NOT retry on disconnect errors. */
export async function callAgentTool(
  code: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<string> {
  try {
    return await callAgentToolOnce(code, tool, args, timeoutMs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Only retry on timeout — disconnect errors won't succeed on retry
    if (msg.includes('timeout')) {
      return callAgentToolOnce(code, tool, args, timeoutMs)
    }
    throw err
  }
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

/** Get the public URL for remote agents (tunnel or manual override). */
export { getPublicRelayUrl } from './tunnel.js'

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

  // Setup public URL: manual override > auto-tunnel > none (LAN fallback)
  if (env.RELAY_PUBLIC_URL) {
    setPublicRelayUrl(env.RELAY_PUBLIC_URL)
    console.log(`[relay] Public URL (manual): ${env.RELAY_PUBLIC_URL}`)
  } else if (env.RELAY_TUNNEL) {
    startTunnel(port).catch((err) => {
      console.error(`[relay] Failed to start tunnel: ${err instanceof Error ? err.message : err}`)
    })
  }

  wss.on('connection', (ws, req) => {
    let role: 'unknown' | 'agent' | 'proxy' | 'electron_chat' = 'unknown'
    let assignedCode = ''
    let assignedVirtualChatId = 0
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
        if (msg.type === 'electron_chat_register') {
          role = 'electron_chat'
          const chatMsg = msg as ElectronChatRegister
          handleElectronChatRegister(ws, chatMsg.code, chatMsg.clientId, ip)
          return
        }
        send(ws, { type: 'error', error: 'First message must be agent_register, proxy_connect, or electron_chat_register' })
        ws.close()
        return
      }

      // Subsequent messages — proxy handled by its own listener
      if (role === 'proxy') return

      if (role === 'agent') {
        handleAgentMessage(ws, assignedCode, msg)
      }

      if (role === 'electron_chat') {
        if (msg.type === 'chat_message') {
          handleElectronChatMessage(ws, assignedVirtualChatId, msg as ChatMessage).catch((err) => {
            console.error(`[relay] Chat message error:`, err instanceof Error ? err.message : err)
          })
        } else if (msg.type === 'chat_callback') {
          handleElectronChatCallback(ws, assignedVirtualChatId, msg as ChatCallback).catch((err) => {
            console.error(`[relay] Chat callback error:`, err instanceof Error ? err.message : err)
          })
        }
      }
    })

    function handleElectronChatRegister(chatWs: WebSocket, code: string, clientId: string, chatIp: string): void {
      const session = findByCode(code)
      // Allow reconnection if code exists in pairing-store OR is a known Electron code
      // (pairing-store codes get recycled on /pair re-run, but virtual-chat-store retains them)
      if (!session && !isCodeUsedByVirtualChat(code)) {
        if (isRateLimited(chatIp)) {
          send(chatWs, { type: 'error', error: 'Too many attempts. Try again later.' })
          chatWs.close()
          return
        }
        send(chatWs, { type: 'error', error: 'Invalid pairing code' })
        chatWs.close()
        return
      }

      const virtualChatId = getOrCreateVirtualChat(clientId, code)
      assignedCode = code
      assignedVirtualChatId = virtualChatId

      registerVirtualChat(virtualChatId, chatWs, code)

      // Auto-set to remote mode so Claude has remote tools (MCP) for the Electron user's machine
      setUserProject(virtualChatId, { name: 'remote', path: process.cwd() })

      const resp: ElectronChatRegistered = {
        type: 'electron_chat_registered',
        virtualChatId,
      }
      chatWs.send(JSON.stringify(resp))
      console.log(`[relay] Electron chat registered: clientId=${clientId.slice(0, 8)}... chatId=${virtualChatId} from=${chatIp}`)
    }

    ws.on('close', () => {
      if (role === 'agent' && assignedCode) {
        const current = agents.get(assignedCode)
        if (current?.ws === ws) {
          agents.delete(assignedCode)

          // Check if this was a graceful shutdown
          const gracefulReason = gracefulShutdowns.get(assignedCode)
          gracefulShutdowns.delete(assignedCode)
          markDisconnected(assignedCode, gracefulReason)

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

          console.log(`[relay] Agent disconnected: code=${assignedCode} reason=${gracefulReason ?? '連線中斷'}`)
        }
      }

      if (role === 'electron_chat' && assignedVirtualChatId) {
        unregisterVirtualChat(assignedVirtualChatId)
        console.log(`[relay] Electron chat disconnected: chatId=${assignedVirtualChatId}`)
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
