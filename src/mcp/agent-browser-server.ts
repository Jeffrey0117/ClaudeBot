#!/usr/bin/env tsx
/**
 * MCP Agent-Browser Server — wraps `agent-browser` CLI as MCP tools.
 *
 * Tools provided (all prefixed `ab_` to avoid collision with browser-server):
 *   - ab_open(url)        → Navigate to URL
 *   - ab_snapshot()       → Accessibility tree (interactive elements)
 *   - ab_click(ref)       → Click element by ref (e.g. "e5")
 *   - ab_fill(ref, text)  → Clear + fill input field
 *   - ab_press(key)       → Press key (Enter, Escape, Tab)
 *   - ab_screenshot()     → Take PNG screenshot (returns base64 image)
 *   - ab_back()           → Go back in history
 *   - ab_get_url()        → Get current URL
 *
 * Usage:
 *   npx tsx src/mcp/agent-browser-server.ts          (standalone)
 *   Claude CLI --mcp-config mcp-agent-browser.json   (integrated)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// --- Constants ---

const TIMEOUT_MS = 30_000

// SSRF protection: block private/internal URLs
const BLOCKED_URL_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|0\.0\.0\.0)/i

function validateUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`)
    }
    if (BLOCKED_URL_RE.test(url)) {
      throw new Error('Access to internal/private URLs is not allowed')
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`)
    }
    throw error
  }
}

// --- CLI Helper ---

function runAB(...args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'agent-browser',
      args as string[],
      { timeout: TIMEOUT_MS, shell: true, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message
          reject(new Error(msg))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

// --- MCP Server ---

const server = new Server(
  { name: 'agent-browser', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ab_open',
      description: 'Navigate to a URL using agent-browser',
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
        'Get accessibility tree snapshot of the current page (interactive elements with role, name, and ref)',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_click',
      description: 'Click an element by its ref attribute (e.g. "e5" from snapshot)',
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
      description: 'Clear and fill an input field by ref',
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
      description: 'Press a key (Enter, Escape, Tab, etc.)',
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
      description: 'Take a PNG screenshot of the current page',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_back',
      description: 'Go back in browser history',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ab_get_url',
      description: 'Get the current page URL',
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

  try {
    switch (name) {
      case 'ab_open': {
        const url = String(a.url)
        validateUrl(url)
        const text = await runAB('open', url)
        return { content: [{ type: 'text', text: text || `Navigated to ${url}` }] }
      }
      case 'ab_snapshot': {
        const text = await runAB('snapshot', '-i')
        return { content: [{ type: 'text', text }] }
      }
      case 'ab_click': {
        const text = await runAB('click', String(a.ref))
        return { content: [{ type: 'text', text: text || `Clicked ${a.ref}` }] }
      }
      case 'ab_fill': {
        const text = await runAB('fill', String(a.ref), String(a.text))
        return { content: [{ type: 'text', text: text || `Filled ${a.ref}` }] }
      }
      case 'ab_press': {
        const text = await runAB('press', String(a.key))
        return { content: [{ type: 'text', text: text || `Pressed ${a.key}` }] }
      }
      case 'ab_screenshot': {
        const screenshotPath = path.join(tmpdir(), `ab-screenshot-${Date.now()}.png`)
        await runAB('screenshot', '--output', screenshotPath)
        try {
          const buffer = await readFile(screenshotPath)
          const base64 = buffer.toString('base64')
          await unlink(screenshotPath).catch(() => {})
          return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] }
        } catch {
          // Fallback: screenshot may output to stdout as text info
          const text = await runAB('screenshot')
          return { content: [{ type: 'text', text }] }
        }
      }
      case 'ab_back': {
        const text = await runAB('back')
        return { content: [{ type: 'text', text: text || 'Navigated back' }] }
      }
      case 'ab_get_url': {
        const text = await runAB('get', 'url')
        return { content: [{ type: 'text', text }] }
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// --- Cleanup on exit ---

async function cleanup(): Promise<void> {
  await runAB('close').catch(() => {})
}

process.on('SIGINT', async () => {
  await cleanup()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await cleanup()
  process.exit(0)
})

// --- Start ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP agent-browser server failed:', err)
  process.exit(1)
})
