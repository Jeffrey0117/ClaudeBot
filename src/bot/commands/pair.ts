import { networkInterfaces } from 'node:os'
import type { BotContext } from '../../types/context.js'
import {
  createPairingCode,
  getPairing,
  removePairing,
} from '../../remote/pairing-store.js'
import { getRelayPort, getPublicRelayUrl } from '../../remote/relay-server.js'
import { remoteToolCall } from '../../remote/relay-client.js'
import { env } from '../../config/env.js'

function getLocalIp(): string {
  const nets = networkInterfaces()
  for (const entries of Object.values(nets)) {
    if (!entries) continue
    for (const entry of entries) {
      if (!entry.internal && entry.family === 'IPv4') {
        return entry.address
      }
    }
  }
  return 'localhost'
}

function getRelayUrl(): { url: string; isPublic: boolean } {
  const publicUrl = getPublicRelayUrl()
  if (publicUrl) {
    return { url: publicUrl, isPublic: true }
  }
  const port = getRelayPort() || env.RELAY_PORT
  const ip = getLocalIp()
  return { url: `ws://${ip}:${port}`, isPublic: false }
}

export async function pairCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const arg = text.split(/\s+/)[1]?.toLowerCase()

  // /pair chat → Electron chat client shortcut
  if (arg === 'chat') {
    return pairChatCommand(ctx, chatId, threadId)
  }

  const existing = getPairing(chatId, threadId)

  // Already paired and connected
  if (existing?.connected) {
    const elapsed = ((Date.now() - existing.createdAt) / 1000 / 60).toFixed(0)
    await ctx.reply(
      `🔗 *已配對* ${existing.label}\n` +
      `已連線 ${elapsed} 分鐘\n\n` +
      `用 /unpair 斷開`,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Generate new pairing code
  const code = createPairingCode(chatId, threadId)
  const { url: wsUrl, isPublic } = getRelayUrl()

  // First-time setup command (clone + install + run)
  const setupCmd = `git clone https://github.com/Jeffrey0117/ClaudeBot.git && cd ClaudeBot && npm install && npx tsx src/remote/agent.ts ${wsUrl} ${code}`

  // Reconnect command (already in ClaudeBot dir — pull latest first)
  const reconnectCmd = `git stash && git pull && npx tsx src/remote/agent.ts ${wsUrl} ${code}`

  const networkNote = isPublic
    ? '🌐 公開 URL — 跨網路可用'
    : '🏠 區網 URL — 需同個 WiFi（設 `RELAY_TUNNEL=true` 開啟跨網路）'

  await ctx.reply(
    `🔑 *配對碼: \`${code}\`*\n\n` +
    `👇 *首次* — 複製貼到 terminal:\n` +
    '```\n' +
    `${setupCmd}\n` +
    '```\n\n' +
    `👇 *已裝過* — 直接連:\n` +
    '```\n' +
    `${reconnectCmd}\n` +
    '```\n\n' +
    `💡 指定專案目錄加在最後面，例如:\n` +
    `\`...${code} C:\\\\path\\\\to\\\\project\`\n\n` +
    `💬 桌面聊天客戶端: \`/pair chat\`\n\n` +
    `${networkNote}\n` +
    `_配對碼 5 分鐘後過期_`,
    { parse_mode: 'Markdown' },
  )
}

async function pairChatCommand(ctx: BotContext, chatId: number, threadId: number | undefined): Promise<void> {
  // Check if remote agent is already connected — auto-launch Electron on remote
  const existing = getPairing(chatId, threadId)
  if (existing?.connected) {
    const chatCode = createPairingCode(chatId, threadId)
    const { url: wsUrl } = getRelayUrl()

    await ctx.reply('💬 正在遠端啟動桌面聊天客戶端...')

    try {
      // Use a tiny Node.js launcher script that:
      // 1. Resolves electron.exe from node_modules/electron/path.txt
      // 2. Spawns it detached with stderr → data/electron-launch.log
      // 3. Exits immediately (so remote_execute_command returns quickly)
      // This avoids all the Windows shell/detach/GUI session issues.
      const launchCmd = `node dist/remote/electron/launch-electron.cjs dist/remote/electron/main.cjs --chat --url ${wsUrl} --code ${chatCode}`

      await remoteToolCall(
        existing.code,
        'remote_execute_command',
        { command: launchCmd, timeout: 15000 },
        15_000,
      )
      await ctx.reply(
        `✅ 已在遠端開啟聊天視窗\n\n` +
        `_配對碼 5 分鐘後過期_`,
        { parse_mode: 'Markdown' },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(
        `❌ 自動啟動失敗: ${msg}\n\n` +
        `💡 手動啟動 — 在遠端 ClaudeBot 目錄貼上:\n` +
        '```\n' +
        `npx electron dist/remote/electron/main.cjs --chat --url ${wsUrl} --code ${chatCode}\n` +
        '```',
        { parse_mode: 'Markdown' },
      )
    }
    return
  }

  // No remote agent connected — show manual instructions
  const code = createPairingCode(chatId, threadId)
  const { url: wsUrl, isPublic } = getRelayUrl()

  const electronCmd = `git pull && npm run build && npx electron dist/remote/electron/main.cjs --chat --url ${wsUrl} --code ${code}`

  const networkNote = isPublic
    ? '🌐 公開 URL — 跨網路可用'
    : '🏠 區網 URL — 需同個 WiFi'

  await ctx.reply(
    `💬 *桌面聊天客戶端*\n\n` +
    `在 ClaudeBot 目錄下貼上:\n` +
    '```\n' +
    `${electronCmd}\n` +
    '```\n\n' +
    `💡 首次需先 \`npm install\` 裝 electron\n\n` +
    `${networkNote}\n` +
    `_配對碼 5 分鐘後過期_`,
    { parse_mode: 'Markdown' },
  )
}

export async function unpairCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const removed = removePairing(chatId, threadId)

  if (removed) {
    await ctx.reply('🔌 已斷開遠端配對。')
  } else {
    await ctx.reply('目前沒有配對的遠端連線。')
  }
}
