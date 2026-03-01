/**
 * Bot→Relay tool call utility.
 *
 * Opens a short-lived WebSocket to the local relay server,
 * sends a proxy_connect + tool_call, waits for tool_result,
 * then closes the connection.
 *
 * Used by /grab and document push — zero AI cost, direct relay.
 */

import { WebSocket } from 'ws'
import type {
  ProxyConnect,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
} from './protocol.js'
import { getRelayPort } from './relay-server.js'
import { env } from '../config/env.js'

let nextId = 1

export async function remoteToolCall(
  code: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<string> {
  const port = getRelayPort() || env.RELAY_PORT
  const url = `ws://127.0.0.1:${port}`

  return new Promise<string>((resolve, reject) => {
    const id = nextId++
    const ws = new WebSocket(url)
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error(`remoteToolCall timed out after ${timeoutMs}ms`))
      }
    }, timeoutMs)

    function cleanup(): void {
      clearTimeout(timer)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    ws.on('open', () => {
      const connect: ProxyConnect = { type: 'proxy_connect', code }
      ws.send(JSON.stringify(connect))
    })

    ws.on('message', (raw) => {
      if (settled) return
      let msg: { type: string; [key: string]: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'error') {
        settled = true
        cleanup()
        reject(new Error(String(msg.error)))
        return
      }

      if (msg.type === 'proxy_connected') {
        // Now send the tool call
        const req: ToolCallRequest = { id, type: 'tool_call', tool, args }
        ws.send(JSON.stringify(req))
        return
      }

      if (msg.type === 'tool_result') {
        const res = msg as unknown as ToolCallResult
        if (res.id === id) {
          settled = true
          cleanup()
          resolve(res.result)
        }
        return
      }

      if (msg.type === 'tool_error') {
        const err = msg as unknown as ToolCallError
        if (err.id === id) {
          settled = true
          cleanup()
          console.error(`[relay-client] tool_error for ${tool}: ${err.error}`)
          reject(new Error(err.error))
        }
      }
    })

    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error(`WebSocket error: ${err.message}`))
      }
    })

    ws.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('WebSocket closed before receiving result'))
      }
    })
  })
}
