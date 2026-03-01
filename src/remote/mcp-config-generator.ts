/**
 * Generates and cleans up temporary MCP config JSON files
 * for remote pairing sessions.  Each Claude CLI invocation
 * gets its own temp config with the WebSocket URL baked in.
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const TEMP_DIR = path.resolve('data', 'mcp-remote')

function ensureDir(): void {
  mkdirSync(TEMP_DIR, { recursive: true })
}

export function generateRemoteMcpConfig(wsUrl: string, code: string): string {
  ensureDir()

  const id = randomBytes(4).toString('hex')
  const filePath = path.join(TEMP_DIR, `mcp-remote-${id}.json`)

  const proxyScript = path.resolve('src', 'mcp', 'remote-proxy-server.ts')

  const config = {
    mcpServers: {
      'remote-fs': {
        command: 'npx',
        args: ['tsx', proxyScript, '--ws-url', wsUrl, '--code', code],
      },
    },
  }

  writeFileSync(filePath, JSON.stringify(config, null, 2))
  return filePath
}

export function cleanupRemoteMcpConfig(configPath: string): void {
  try {
    unlinkSync(configPath)
  } catch {
    // file may already be gone
  }
}
