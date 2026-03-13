#!/usr/bin/env tsx
/**
 * Interactive setup wizard for ClaudeBot.
 * Run with: npm run setup
 *
 * Guides the user through creating a .env file with all required values.
 * Uses only Node.js built-ins — no extra dependencies.
 */

import { createInterface } from 'node:readline'
import { existsSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

function checkCli(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`
    execSync(cmd, { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const envPath = path.join(process.cwd(), '.env')

  console.log('')
  console.log('╔══════════════════════════════════════╗')
  console.log('║       ClaudeBot Setup Wizard         ║')
  console.log('╚══════════════════════════════════════╝')
  console.log('')

  // Warn if .env already exists
  if (existsSync(envPath)) {
    const overwrite = await ask('  .env already exists. Overwrite? (y/N)', 'N')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Cancelled.')
      rl.close()
      return
    }
    console.log('')
  }

  // Step 0: Check CLI tools
  console.log('  Step 0: Checking CLI tools...')
  console.log('')

  const hasClaude = checkCli('claude')
  const hasGemini = checkCli('gemini')

  if (hasClaude) {
    console.log('  [v] Claude CLI found')
  } else {
    console.log('  [x] Claude CLI not found')
    console.log('      Install: npm install -g @anthropic-ai/claude-code')
    console.log('      Then run: claude     (to login)')
  }

  if (hasGemini) {
    console.log('  [v] Gemini CLI found')
  } else {
    console.log('  [ ] Gemini CLI not found (optional)')
    console.log('      Install: npm install -g @anthropic-ai/claude-code  (or Gemini CLI)')
  }

  if (!hasClaude) {
    console.log('')
    console.log('  Claude CLI is required. Install it first, then re-run setup.')
    console.log('  You can continue anyway if you plan to install it later.')
    console.log('')
    const proceed = await ask('  Continue without Claude CLI? (y/N)', 'N')
    if (proceed.toLowerCase() !== 'y') {
      rl.close()
      return
    }
  }
  console.log('')

  // Step 1: Bot Token
  console.log('  Step 1: Telegram Bot Token')
  console.log('  Open Telegram, search @BotFather, send /newbot, copy the token')
  console.log('')
  let botToken = ''
  while (!botToken) {
    botToken = await ask('  Paste your BOT_TOKEN')
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
      console.log('  Invalid format. Should look like: 123456789:ABCdefGHIjklMNO')
      botToken = ''
    }
  }

  // Verify token
  console.log('  Verifying token...')
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    })
    const data = await res.json() as { ok: boolean; result?: { username?: string } }
    if (data.ok && data.result?.username) {
      console.log(`  Bot found: @${data.result.username}`)
    } else {
      console.log('  Token verification failed, continuing anyway')
    }
  } catch {
    console.log('  Could not verify (network issue), continuing anyway')
  }
  console.log('')

  // Step 2: Chat ID
  console.log('  Step 2: Your Telegram Chat ID')
  console.log('  Open Telegram, search @userinfobot, send any message, copy "Id"')
  console.log('')
  let chatIds = ''
  while (!chatIds) {
    chatIds = await ask('  Your ALLOWED_CHAT_IDS (comma-separated)')
    if (!/^[\d,\s]+$/.test(chatIds)) {
      console.log('  Should be numbers, e.g.: 123456789 or 123456789,987654321')
      chatIds = ''
    }
  }
  chatIds = chatIds.replace(/\s/g, '')
  console.log('')

  // Step 3: Projects directory
  console.log('  Step 3: Projects Directory')
  console.log('  Where are your code projects located?')
  console.log('')
  const defaultDir = process.platform === 'win32'
    ? 'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\code'
    : (process.env.HOME || '~') + '/code'
  const projectsDir = await ask('  PROJECTS_BASE_DIR', defaultDir)
  console.log('')

  // Step 4: Password
  console.log('  Step 4: Login Password')
  console.log('  Used when AUTO_AUTH is disabled. Set one for security.')
  console.log('')
  const password = await ask('  LOGIN_PASSWORD', 'changeme')
  console.log('')

  // Step 5: Model
  console.log('  Step 5: Default AI Model')
  console.log('  haiku = fast & cheap | sonnet = balanced | opus = powerful')
  console.log('')
  let model = await ask('  DEFAULT_MODEL (haiku/sonnet/opus)', 'sonnet')
  if (!['haiku', 'sonnet', 'opus'].includes(model)) {
    console.log(`  Unknown model "${model}", defaulting to sonnet`)
    model = 'sonnet'
  }
  console.log('')

  // Step 6: Plugins
  console.log('  Step 6: Plugins')
  console.log('  Available: screenshot, dice, reminder, sysinfo, browse, cost')
  console.log('')
  const plugins = await ask('  PLUGINS (comma-separated)', 'screenshot,dice,reminder,sysinfo,browse,cost')
  console.log('')

  // Build .env content
  const lines = [
    '# ClaudeBot Configuration (generated by setup wizard)',
    '',
    '# Telegram Bot Token',
    `BOT_TOKEN=${botToken}`,
    '',
    '# Login password',
    `LOGIN_PASSWORD=${password}`,
    '',
    '# Allowed Telegram chat IDs',
    `ALLOWED_CHAT_IDS=${chatIds}`,
    '',
    '# Projects directory',
    `PROJECTS_BASE_DIR=${projectsDir}`,
    '',
    '# Default model',
    `DEFAULT_MODEL=${model}`,
    '',
    '# Auto-authenticate whitelisted chats',
    'AUTO_AUTH=true',
    '',
    '# Rate limit',
    'RATE_LIMIT_MAX=10',
    'RATE_LIMIT_WINDOW_MS=60000',
    '',
    '# Plugins',
    `PLUGINS=${plugins}`,
    '',
  ]

  writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8')

  console.log('---')
  console.log('')
  console.log('  .env created!')
  console.log('')
  console.log('  Next steps:')
  console.log('    npm run dev        Start the bot')
  console.log('    Open Telegram      Find your bot')
  console.log('    Send /start        Begin!')
  console.log('')
  console.log('  Add more bots later with /newbot <token> from Telegram')
  console.log('')
  console.log('  Tip: Windows users can auto-install Node.js, ffmpeg, and')
  console.log('  dependencies in one step with: npx zerosetup')
  console.log('')

  rl.close()
}

main().catch((err) => {
  console.error('Setup failed:', err)
  rl.close()
  process.exit(1)
})
