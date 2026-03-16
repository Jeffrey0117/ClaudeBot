import { networkInterfaces } from 'node:os'
import type { BotContext } from '../../types/context.js'
import {
  createPairingCode,
  getPairing,
  removePairing,
} from '../../remote/pairing-store.js'
import { getRelayPort, getPublicRelayUrl } from '../../remote/relay-server.js'
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
  return '你的IP'
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
    ? '🌐 _公開 URL — 跨網路可用_'
    : '🏠 _區網 URL — 需同個 WiFi（設 RELAY\\_TUNNEL=true 開啟跨網路）_'

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
