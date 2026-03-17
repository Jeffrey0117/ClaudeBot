#!/usr/bin/env tsx
/**
 * MCP Remote Proxy Server — stdio MCP server that forwards
 * tool calls to a remote agent through the relay server.
 *
 * Claude CLI spawns this as a child process.  It connects to the
 * local relay (same process as ClaudeBot) which routes messages
 * to the paired remote agent on computer N.
 *
 * Usage:
 *   npx tsx src/mcp/remote-proxy-server.ts --relay-port 9877 --code 482913
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'
import type {
  ProxyConnect,
  ToolCallRequest,
  ToolCallResult,
  ToolCallError,
} from '../remote/protocol.js'

// --- CLI arg parsing ---

function parseArg(flag: string): string {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) {
    throw new Error(`Missing required argument: ${flag}`)
  }
  return process.argv[idx + 1]
}

const RELAY_PORT = parseInt(parseArg('--relay-port'), 10)
const PAIRING_CODE = parseArg('--code')
const TOOL_TIMEOUT_MS = 120_000
const CONNECT_TIMEOUT_MS = 10_000

// --- WebSocket state ---

let ws: WebSocket | null = null
let requestId = 0
const pendingRequests = new Map<number, {
  resolve: (result: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

// --- Connect to relay ---

function connectToRelay(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${RELAY_PORT}`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`))
    }, CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      const msg: ProxyConnect = { type: 'proxy_connect', code: PAIRING_CODE }
      socket.send(JSON.stringify(msg))
    })

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; error?: string; id?: number; result?: string }

      // Handle handshake
      if (msg.type === 'proxy_connected') {
        clearTimeout(timer)
        ws = socket
        resolve()
        return
      }
      if (msg.type === 'error') {
        clearTimeout(timer)
        socket.close()
        reject(new Error(msg.error ?? 'Relay error'))
        return
      }

      // Handle tool responses
      if ((msg.type === 'tool_result' || msg.type === 'tool_error') && msg.id !== undefined) {
        const pending = pendingRequests.get(msg.id)
        if (!pending) return
        pendingRequests.delete(msg.id)
        clearTimeout(pending.timer)

        if (msg.type === 'tool_result') {
          pending.resolve((msg as ToolCallResult).result)
        } else {
          pending.reject(new Error((msg as ToolCallError).error))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error: ${err.message}`))
    })

    socket.on('close', () => {
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Connection closed'))
        pendingRequests.delete(id)
      }
      ws = null
    })
  })
}

// --- Forward tool call ---

function forwardToolCall(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string> {
  const effectiveTimeout = timeoutMs ?? TOOL_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to relay'))
      return
    }

    const id = requestId++
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Tool call timeout (${effectiveTimeout}ms)`))
    }, effectiveTimeout)

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
      description: 'Read a file on the remote computer. Returns file content (truncated at 500KB).',
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
      description: 'Execute a shell command on the remote computer. Returns stdout + stderr. Supports up to 5 min timeout.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Optional working directory (relative to remote base dir)' },
          timeout: { type: 'number', description: 'Optional timeout in ms (default 120000, max 300000)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'remote_grep',
      description: 'Fast content search (regex) on the remote computer. Auto-excludes node_modules/.git/dist/.next. Returns matching lines with file:line format.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex supported)' },
          path: { type: 'string', description: 'Directory to search in (default: working dir)' },
          include: { type: 'string', description: 'File pattern filter (e.g. "*.ts", "*.json")' },
          maxResults: { type: 'number', description: 'Max results (default 100, max 200)' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'remote_system_info',
      description: 'Get remote system information: OS, user, disk, memory, network.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'remote_project_overview',
      description: 'Get a comprehensive project overview: directory tree (2 levels), CLAUDE.md, package.json, README.md, git status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Project path (default: working dir)' },
        },
      },
    },
    {
      name: 'remote_fetch_file',
      description: 'Download a file from the remote computer as base64. Max 20MB. Relative paths resolve from home dir.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to home dir)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'remote_push_file',
      description: 'Upload a file to the remote computer from base64 data. Max 20MB.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Destination file path on remote' },
          base64: { type: 'string', description: 'Base64-encoded file content' },
        },
        required: ['path', 'base64'],
      },
    },
    {
      name: 'ab_open',
      description: 'Navigate to a URL using agent-browser on the remote computer',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
    {
      name: 'ab_snapshot',
      description:
        'Get accessibility tree snapshot of the current page on the remote browser (interactive elements with role, name, and ref)',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_click',
      description: 'Click an element by its ref attribute on the remote browser (e.g. "e5" from snapshot)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e5")' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'ab_fill',
      description: 'Clear and fill an input field by ref on the remote browser',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e5")' },
          text: { type: 'string', description: 'Text to fill into the field' },
        },
        required: ['ref', 'text'],
      },
    },
    {
      name: 'ab_press',
      description: 'Press a key on the remote browser (Enter, Escape, Tab, etc.)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Key to press (e.g. "Enter", "Escape", "Tab")' },
        },
        required: ['key'],
      },
    },
    {
      name: 'ab_screenshot',
      description: 'Take a PNG screenshot of the current page on the remote browser',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_back',
      description: 'Go back in browser history on the remote browser',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_get_url',
      description: 'Get the current page URL from the remote browser',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_connect_browser',
      description:
        'Connect agent-browser to the user\'s Chrome (with login state/cookies). ' +
        'Kills Chrome and restarts it with CDP debugging port. ' +
        'MUST call this before operating on sites that require login (Gmail, GitHub, etc.). ' +
        'After this, all ab_* tools will control the user\'s actual Chrome.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  // Timeout: browser ops get 45s, execute_command gets custom, others default
  const customTimeout = name === 'remote_execute_command' && a.timeout
    ? Math.min(Number(a.timeout) + 5_000, 305_000) // agent timeout + 5s buffer
    : name === 'ab_connect_browser' ? 30_000
    : name.startsWith('ab_') ? 75_000 // 60s agent-browser + 15s relay buffer
    : undefined

  try {
    const result = await forwardToolCall(name, a, customTimeout)

    // ab_screenshot returns JSON image envelope from N-side
    if (name === 'ab_screenshot') {
      try {
        const parsed = JSON.parse(result) as { type?: string; base64?: string }
        if (parsed.type === 'image' && parsed.base64) {
          return { content: [{ type: 'image', data: parsed.base64, mimeType: 'image/png' }] }
        }
      } catch { /* fall through to text */ }
    }

    return { content: [{ type: 'text', text: result }] }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// --- Cleanup ---

process.on('SIGINT', () => { ws?.close(); process.exit(0) })
process.on('SIGTERM', () => { ws?.close(); process.exit(0) })

// --- Start ---

async function main(): Promise<void> {
  await connectToRelay()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP remote proxy server failed:', err)
  process.exit(1)
})
