/**
 * Channel session launcher (POC) — runs a PERSISTENT INTERACTIVE `claude`
 * session inside a pseudo-terminal (node-pty) with our custom channel attached.
 *
 * Why a pty: headless/background `claude` (no TTY) falls back to --print (-p),
 * which is exactly what we're trying to avoid. node-pty gives it a real
 * terminal so it runs as a true INTERACTIVE session — so usage can draw from
 * the interactive credit pool, not the programmatic (-p) pool.
 *
 *   npx tsx src/mcp/channel-launcher.ts
 *
 * Once up, the channel server's HTTP bridge listens on :8790. Drive it:
 *   curl -X POST localhost:8790/msg -d '{"text":"reply with PONG"}'
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import * as pty from 'node-pty'

/** Same resolution the bot's claude-runner uses (native 2.x bin vs 1.x cli.js). */
function resolveClaudeCli(): { cmd: string; prefix: string[] } {
  if (process.platform !== 'win32') return { cmd: 'claude', prefix: [] }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', windowsHide: true })
      .trim().split('\n')[0].trim()
    const ccDir = path.join(path.dirname(cmdPath), 'node_modules', '@anthropic-ai', 'claude-code')
    const cliJs = path.join(ccDir, 'cli.js')
    if (fs.existsSync(cliJs)) return { cmd: process.execPath, prefix: [cliJs] }
    const binExe = path.join(ccDir, 'bin', 'claude.exe')
    if (fs.existsSync(binExe)) return { cmd: binExe, prefix: [] }
    return { cmd: 'claude', prefix: [] }
  } catch {
    return { cmd: 'claude', prefix: [] }
  }
}

// Run in an ISOLATED dir whose .mcp.json registers the "claudebot" server.
// The --channels resolver reads .mcp.json from cwd (NOT --mcp-config), and the
// bot isn't --strict-mcp-config, so we must NOT put .mcp.json in the repo root
// (it would auto-load into every bot -p run). This subdir is its own root.
const sessionCwd = path.join(process.cwd(), 'data', 'channel-poc')

const { cmd, prefix } = resolveClaudeCli()
const args = [
  ...prefix,
  // Custom server: channels REQUIRE the dev flag (plain --channels only loads
  // allowlisted plugin channels). One-time confirm prompt cleared via pty below.
  '--dangerously-load-development-channels', 'server:claudebot',
  // Pre-allow only our reply tool instead of --dangerously-skip-permissions
  // (which would add a SECOND bypass-warning prompt).
  '--allowedTools', 'mcp__claudebot__reply',
]

console.error(`[channel-launcher] spawning in pty: ${cmd} ${args.join(' ')}`)

const term = pty.spawn(cmd, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: sessionCwd,
  env: process.env as Record<string, string>,
})

const ENTER = '\r'
const write = (s: string) => { try { term.write(s) } catch { /* ignore */ } }

// Content-driven startup-gate handling. The TUI positions each char with its
// own ANSI escape, so the stream has NO spaces between words — match against
// an ANSI- AND whitespace-stripped rolling view. Each gate handled once; the
// confirm Enter is fired a few times spaced out to beat mid-render drops.
let rolling = ''
const done = new Set<string>()
const confirm = (key: string) => {
  if (done.has(key)) return
  done.add(key)
  rolling = ''
  for (const t of [400, 1500, 3000]) setTimeout(() => write(ENTER), t)
}
term.onData((d) => {
  process.stderr.write(d)
  const flat = d.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, '')
  rolling = (rolling + flat).slice(-8000)
  // Startup gauntlet — each prompt's default/checked state is the accept,
  // so a plain Enter confirms (fired a few times to beat mid-render drops).
  if (/newMCPserver/i.test(rolling)) confirm('mcp-enable')            // "N new MCP servers found" (pre-checked)
  else if (/localdevelopment/i.test(rolling) && /Exit/i.test(rolling)) confirm('dev-channel')
  else if (/trust/i.test(rolling) && /(proceed|yes)/i.test(rolling)) confirm('trust')
})

term.onExit(({ exitCode }) => {
  console.error(`[channel-launcher] claude session exited (code ${exitCode})`)
  process.exit(exitCode ?? 0)
})

process.on('SIGTERM', () => { try { term.kill() } catch { /* ignore */ } })
process.on('SIGINT', () => { try { term.kill() } catch { /* ignore */ } })
