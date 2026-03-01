#!/usr/bin/env node
/**
 * ClaudeBot Remote Agent — runs on the friend's computer (N-side).
 *
 * Starts a WebSocket server, displays a pairing code, and executes
 * filesystem / shell operations forwarded from the ClaudeBot MCP proxy.
 *
 * Usage:
 *   npx tsx src/remote/agent.ts [port] [base-dir]
 *   npx tsx src/remote/agent.ts 9876 /path/to/project
 *
 * Defaults: port=9876, base-dir=cwd
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { resolve, join, relative, sep } from 'node:path'
import { randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type {
  ProxyMessage,
  ToolCallResult,
  ToolCallError,
  PairOk,
  PairFail,
} from './protocol.js'

// --- Config ---

const PORT = parseInt(process.argv[2] || '9876', 10)
const BASE_DIR = resolve(process.argv[3] || process.cwd())
const PAIRING_CODE = String(randomInt(100000, 999999))
const MAX_FILE_SIZE = 100 * 1024 // 100KB
const EXEC_TIMEOUT_MS = 30_000

// --- State ---

let paired = false
let activeClient: WebSocket | null = null
let failedAttempts = 0
const MAX_FAILED_ATTEMPTS = 5

// --- Security ---

function validatePath(targetPath: string): string {
  const resolved = resolve(BASE_DIR, targetPath)
  const baseNorm = resolve(BASE_DIR) + sep
  if (!resolved.startsWith(baseNorm) && resolved !== resolve(BASE_DIR)) {
    throw new Error('Path traversal blocked')
  }
  return resolved
}

// --- Tool handlers ---

async function handleReadFile(args: Record<string, unknown>): Promise<string> {
  const filePath = validatePath(String(args.path))
  const stats = await stat(filePath)
  if (stats.size > MAX_FILE_SIZE) {
    const content = await readFile(filePath, 'utf-8')
    return content.slice(0, MAX_FILE_SIZE) + `\n\n[truncated at ${MAX_FILE_SIZE} bytes, total: ${stats.size}]`
  }
  return await readFile(filePath, 'utf-8')
}

async function handleWriteFile(args: Record<string, unknown>): Promise<string> {
  const filePath = validatePath(String(args.path))
  const content = String(args.content)
  const dir = resolve(filePath, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, content, 'utf-8')
  return `Written ${content.length} bytes to ${relative(BASE_DIR, filePath)}`
}

async function handleListDirectory(args: Record<string, unknown>): Promise<string> {
  const dirPath = validatePath(String(args.path))
  const entries = await readdir(dirPath, { withFileTypes: true })
  const lines = entries.map((entry) => {
    const type = entry.isDirectory() ? 'dir' : 'file'
    return `[${type}] ${entry.name}`
  })
  return lines.join('\n') || '(empty directory)'
}

async function handleSearchFiles(args: Record<string, unknown>): Promise<string> {
  const searchPath = validatePath(String(args.path))
  const pattern = String(args.pattern || '*')
  const contentPattern = args.contentPattern ? String(args.contentPattern) : undefined

  // Use a simple recursive search
  const results: string[] = []
  const MAX_RESULTS = 50

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_RESULTS) return
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break
        const fullPath = join(dir, entry.name)

        // Skip node_modules, .git
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue

        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (matchGlob(entry.name, pattern)) {
          if (contentPattern) {
            try {
              const content = await readFile(fullPath, 'utf-8')
              if (content.includes(contentPattern)) {
                results.push(relative(BASE_DIR, fullPath))
              }
            } catch {
              // skip binary / unreadable files
            }
          } else {
            results.push(relative(BASE_DIR, fullPath))
          }
        }
      }
    } catch {
      // skip inaccessible directories
    }
  }

  await walk(searchPath)
  const suffix = results.length >= MAX_RESULTS ? `\n(limited to ${MAX_RESULTS} results)` : ''
  return results.join('\n') + suffix || '(no matches)'
}

function matchGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  // Simple glob: *.ts, *.js, etc.
  if (pattern.startsWith('*.')) {
    return name.endsWith(pattern.slice(1))
  }
  return name.includes(pattern)
}

async function handleExecuteCommand(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command)
  const cwd = args.cwd ? validatePath(String(args.cwd)) : BASE_DIR

  return new Promise((res) => {
    exec(command, { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trim())
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      if (error && !stdout && !stderr) parts.push(`Error: ${error.message}`)
      res(parts.join('\n\n') || '(no output)')
    })
  })
}

// --- Tool dispatch ---

async function dispatchTool(tool: string, args: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case 'remote_read_file': return handleReadFile(args)
    case 'remote_write_file': return handleWriteFile(args)
    case 'remote_list_directory': return handleListDirectory(args)
    case 'remote_search_files': return handleSearchFiles(args)
    case 'remote_execute_command': return handleExecuteCommand(args)
    default: throw new Error(`Unknown tool: ${tool}`)
  }
}

// --- WebSocket server ---

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg: ProxyMessage
    try {
      msg = JSON.parse(raw.toString()) as ProxyMessage
    } catch {
      ws.send(JSON.stringify({ type: 'pair_fail', error: 'Invalid JSON' }))
      return
    }

    // Pairing handshake
    if (msg.type === 'pair') {
      if (msg.code === PAIRING_CODE) {
        // Disconnect previous client if any
        if (activeClient && activeClient !== ws) {
          activeClient.close()
        }
        paired = true
        activeClient = ws
        failedAttempts = 0
        const resp: PairOk = { type: 'pair_ok' }
        ws.send(JSON.stringify(resp))
        console.log(`✅ Paired with ${getRemoteAddr(ws)}`)
      } else {
        failedAttempts++
        const resp: PairFail = { type: 'pair_fail', error: 'Invalid pairing code' }
        ws.send(JSON.stringify(resp))
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          console.error(`⛔ Too many failed attempts (${failedAttempts}), closing connection`)
          ws.close()
        }
      }
      return
    }

    // Only accept tool calls from paired client
    if (!paired || ws !== activeClient) {
      if (msg.type === 'tool_call') {
        const resp: ToolCallError = { id: msg.id, type: 'tool_error', error: 'Not paired' }
        ws.send(JSON.stringify(resp))
      }
      return
    }

    // Tool call dispatch
    if (msg.type === 'tool_call') {
      try {
        const result = await dispatchTool(msg.tool, msg.args)
        const resp: ToolCallResult = { id: msg.id, type: 'tool_result', result }
        ws.send(JSON.stringify(resp))
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const resp: ToolCallError = { id: msg.id, type: 'tool_error', error }
        ws.send(JSON.stringify(resp))
      }
    }
  })

  ws.on('close', () => {
    if (ws === activeClient) {
      paired = false
      activeClient = null
      console.log('🔌 Disconnected. Waiting for new pairing...')
    }
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    if (ws === activeClient) {
      paired = false
      activeClient = null
    }
  })
})

// --- Helpers ---

function getRemoteAddr(ws: WebSocket): string {
  const req = (ws as unknown as { _socket?: { remoteAddress?: string } })._socket
  return req?.remoteAddress ?? 'unknown'
}

function getLocalIP(): string {
  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address
      }
    }
  }
  return '127.0.0.1'
}

// --- Startup ---

console.log('')
console.log('╔══════════════════════════════════════╗')
console.log('║     ClaudeBot Remote Agent           ║')
console.log('╠══════════════════════════════════════╣')
console.log(`║  Pairing code:  ${PAIRING_CODE}                ║`)
console.log(`║  Address:       ${getLocalIP()}:${PORT}    ║`)
console.log(`║  Working dir:   ${BASE_DIR.length > 20 ? '...' + BASE_DIR.slice(-17) : BASE_DIR.padEnd(20)}║`)
console.log('╠══════════════════════════════════════╣')
console.log('║  Waiting for connection...           ║')
console.log('╚══════════════════════════════════════╝')
console.log('')
console.log(`Telegram: /pair ${PAIRING_CODE}@${getLocalIP()}:${PORT}`)
console.log('')
