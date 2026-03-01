#!/usr/bin/env tsx
/**
 * MCP Remote Proxy Server — stdio MCP server that forwards
 * tool calls to a remote agent via WebSocket.
 *
 * Claude CLI spawns this as a child process.  Instead of
 * executing tools locally, it serializes them over WebSocket
 * to the remote agent on computer N.
 *
 * Usage:
 *   npx tsx src/mcp/remote-proxy-server.ts --ws-url ws://192.168.1.50:9876 --code 482913
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'
import type {
  PairRequest,
  ToolCallRequest,
  AgentResponse,
} from '../remote/protocol.js'

// --- CLI arg parsing ---

function parseArg(flag: string): string {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) {
    throw new Error(`Missing required argument: ${flag}`)
  }
  return process.argv[idx + 1]
}

const WS_URL = parseArg('--ws-url')
const PAIRING_CODE = parseArg('--code')
const TOOL_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000

// --- WebSocket state ---

let ws: WebSocket | null = null
let requestId = 0
const pendingRequests = new Map<number, {
  resolve: (result: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

// --- Connect to remote agent ---

function connectToAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`))
    }, CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      const pairMsg: PairRequest = { type: 'pair', code: PAIRING_CODE }
      socket.send(JSON.stringify(pairMsg))
    })

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentResponse

      // Handle pairing response
      if (msg.type === 'pair_ok') {
        clearTimeout(timer)
        ws = socket
        resolve()
        return
      }
      if (msg.type === 'pair_fail') {
        clearTimeout(timer)
        socket.close()
        reject(new Error(msg.error))
        return
      }

      // Handle tool call responses
      if (msg.type === 'tool_result' || msg.type === 'tool_error') {
        const pending = pendingRequests.get(msg.id)
        if (!pending) return
        pendingRequests.delete(msg.id)
        clearTimeout(pending.timer)

        if (msg.type === 'tool_result') {
          pending.resolve(msg.result)
        } else {
          pending.reject(new Error(msg.error))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error: ${err.message}`))
    })

    socket.on('close', () => {
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('WebSocket connection closed'))
        pendingRequests.delete(id)
      }
      ws = null
    })
  })
}

// --- Forward tool call to remote agent ---

function forwardToolCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to remote agent'))
      return
    }

    const id = requestId++
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Tool call timeout (${TOOL_TIMEOUT_MS}ms)`))
    }, TOOL_TIMEOUT_MS)

    pendingRequests.set(id, { resolve, reject, timer })

    const msg: ToolCallRequest = { id, type: 'tool_call', tool, args }
    ws.send(JSON.stringify(msg))
  })
}

// --- MCP Server ---

const server = new Server(
  { name: 'remote-fs', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'remote_read_file',
      description: 'Read a file on the remote computer. Returns file content (truncated at 100KB).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path (relative to remote working dir)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'remote_write_file',
      description: 'Write content to a file on the remote computer. Creates parent directories automatically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path (relative to remote working dir)' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'remote_list_directory',
      description: 'List files and directories at a path on the remote computer.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Directory path (relative to remote working dir)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'remote_search_files',
      description: 'Search for files by name pattern on the remote computer. Optionally filter by content.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Directory to search in' },
          pattern: { type: 'string', description: 'Filename pattern (e.g. "*.ts", "*.json")' },
          contentPattern: { type: 'string', description: 'Optional: search for files containing this text' },
        },
        required: ['path', 'pattern'],
      },
    },
    {
      name: 'remote_execute_command',
      description: 'Execute a shell command on the remote computer. Returns stdout + stderr.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Optional working directory (relative to remote base dir)' },
        },
        required: ['command'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  try {
    const result = await forwardToolCall(name, a)
    return { content: [{ type: 'text', text: result }] }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// --- Cleanup ---

function cleanup(): void {
  if (ws) {
    ws.close()
    ws = null
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

// --- Start ---

async function main(): Promise<void> {
  await connectToAgent()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP remote proxy server failed:', err)
  process.exit(1)
})
