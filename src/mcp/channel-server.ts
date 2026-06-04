/**
 * ClaudeBot Channel — custom Claude Code "channel" MCP server (POC).
 *
 * Goal: prove we can drive a PERSISTENT INTERACTIVE `claude` session
 * programmatically (replacing `claude -p`), so usage draws from the
 * interactive credit pool instead of the programmatic pool (post 2026-06-15).
 *
 * Launch (research preview):
 *   claude --mcp-config data/mcp-channel.json \
 *          --dangerously-load-development-channels server:claudebot
 *
 * Flow:
 *   POST /msg {chat_id?, text}  → push <channel> event into Claude  → long-poll
 *   Claude reads the event, calls the `reply` tool                  → resolves
 *   POST /msg returns Claude's reply text
 *
 * Pure MCP over stdio (spawned by Claude Code) + a localhost HTTP bridge.
 */

import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const PORT = Number(process.env.CHANNEL_PORT) || 8790
const REPLY_TIMEOUT_MS = 180_000

// chat_id → resolver waiting for Claude's reply (long-poll correlation)
const pending = new Map<string, (text: string) => void>()
let seq = 0

const server = new Server(
  { name: 'claudebot', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Messages from the ClaudeBot user arrive as ' +
      '<channel source="claudebot" chat_id="...">text</channel>. ' +
      'Treat each as a user request. When you have your answer, you MUST call ' +
      'the `reply` tool exactly once, passing the SAME chat_id from the tag and ' +
      'your full answer as text. Do not reply in plain prose — only via the tool.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send your answer back to the ClaudeBot user over the channel.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the <channel> tag' },
          text: { type: 'string', description: 'Your full answer' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const args = (req.params.arguments ?? {}) as { chat_id?: string; text?: string }
    const chatId = String(args.chat_id ?? 'default')
    const text = String(args.text ?? '')
    const resolve = pending.get(chatId)
    if (resolve) {
      pending.delete(chatId)
      resolve(text)
    }
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

/** Push a user message into the live Claude session and wait for its reply. */
function ask(chatId: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(chatId)) {
        pending.delete(chatId)
        resolve('(timeout — no reply within window)')
      }
    }, REPLY_TIMEOUT_MS)
    pending.set(chatId, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    // One-way push into Claude's context. Arrives as <channel source="claudebot" chat_id=...>.
    void server.notification({
      method: 'notifications/claude/channel',
      params: { content: text, meta: { chat_id: chatId } },
    })
  })
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const http = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/msg') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}') as { chat_id?: string; text?: string }
      const text = (body.text ?? '').trim()
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'text required' }))
        return
      }
      const chatId = String(body.chat_id ?? `poc-${++seq}`)
      const reply = await ask(chatId, text)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ chat_id: chatId, reply }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
    return
  }
  res.writeHead(404)
  res.end('not found')
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
  http.listen(PORT, '127.0.0.1', () => {
    // stderr only — stdout is the MCP stdio channel, must stay clean
    console.error(`[channel] bridge listening on http://127.0.0.1:${PORT}/msg`)
  })
}

main().catch((err) => {
  console.error('[channel] fatal:', err)
  process.exit(1)
})
