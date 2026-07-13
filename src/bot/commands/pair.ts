import { networkInterfaces } from 'node:os'
import type { BotContext } from '../../types/context.js'
import {
  createPairingCode,
  getPairing,
  getPairings,
  removePairing,
} from '../../remote/pairing-store.js'
import { getRelayPort, getPublicRelayUrl } from '../../remote/relay-server.js'
import { remoteToolCall } from '../../remote/relay-client.js'
import { env } from '../../config/env.js'
import { getActiveMachine, setActiveMachine } from '../state.js'
import { Markup } from 'telegraf'

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

/** Format machine list for display. */
function formatMachineList(
  pairings: readonly import('../../remote/pairing-store.js').PairingSession[],
  activeMachine: string | undefined,
): string {
  if (pairings.length === 0) return ''
  const lines = pairings.map((s) => {
    const isActive = s.label === activeMachine
    const icon = s.connected ? (isActive ? '✅' : '🔗') : '⭕'
    const activeTag = isActive ? ' (active)' : ''
    const label = s.label || s.code
    return `${icon} ${label}${activeTag}${s.connected ? '' : ' — disconnected'}`
  })
  return `\n\n*已配對機器:*\n${lines.join('\n')}`
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

  // /pair bat → one-time code to fetch BAT remote credentials on another machine
  if (arg === 'bat') {
    return pairBatCommand(ctx, chatId, threadId)
  }

  // Always allow creating new pairing codes (multi-machine support)
  const code = createPairingCode(chatId, threadId)
  const { url: wsUrl, isPublic } = getRelayUrl()

  const networkNote = isPublic
    ? '🌐 公開 URL — 跨網路可用'
    : '🏠 區網 URL — 需同個 WiFi（設 `RELAY_TUNNEL=true` 開啟跨網路）'

  // Show existing machines if any
  const existing = getPairings(chatId, threadId).filter((s) => s.connected)
  const activeMch = getActiveMachine(chatId, threadId)
  const machineList = formatMachineList(existing, activeMch)

  await ctx.reply(
    `🔑 *配對資訊*\n\n` +
    `📡 *Server:*\n` +
    '```\n' + wsUrl + '\n```\n\n' +
    `🔐 *配對碼:*\n` +
    '```\n' + code + '\n```\n\n' +
    `_在 Electron 桌面客戶端貼上即可連線_\n` +
    `_配對碼 5 分鐘後過期_\n\n` +
    `${networkNote}` +
    machineList,
    { parse_mode: 'Markdown' },
  )
}

async function pairChatCommand(ctx: BotContext, chatId: number, threadId: number | undefined): Promise<void> {
  // Check if remote agent is already connected — auto-launch Electron on remote
  const activeMch = getActiveMachine(chatId, threadId)
  const existing = getPairing(chatId, threadId, activeMch)
  if (existing?.connected) {
    // Reuse the agent's existing code — don't overwrite the pairing
    const chatCode = existing.code
    const { url: wsUrl } = getRelayUrl()

    await ctx.reply('💬 正在遠端啟動桌面聊天客戶端...')

    try {
      // Launch Electron via run-electron.cjs wrapper.
      // IMPORTANT: Pass URL/code via env vars, NOT argv.
      // Chromium crashes when argv contains wss:// or https:// URLs.
      // "start "" /b" runs the command in background so remote_execute_command returns immediately
      const launchCmd = `start "" /b cmd /c "set CLAUDEBOT_URL=${wsUrl}&& set CLAUDEBOT_CODE=${chatCode}&& node run-electron.cjs dist/remote/electron/main.cjs --chat"`

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
        `set CLAUDEBOT_URL=${wsUrl}&& set CLAUDEBOT_CODE=${chatCode}&& node run-electron.cjs dist/remote/electron/main.cjs --chat\n` +
        '```',
        { parse_mode: 'Markdown' },
      )
    }
    return
  }

  // No remote agent connected — show manual instructions
  const code = createPairingCode(chatId, threadId)
  const { url: wsUrl, isPublic } = getRelayUrl()

  const electronCmd = `git pull\nnpm run build\nset CLAUDEBOT_URL=${wsUrl}&& set CLAUDEBOT_CODE=${code}&& node run-electron.cjs dist/remote/electron/main.cjs --chat`

  const networkNote = isPublic
    ? '🌐 公開 URL — 跨網路可用'
    : '🏠 區網 URL — 需同個 WiFi'

  await ctx.reply(
    `💬 *桌面聊天客戶端*\n\n` +
    `📡 *Server:*\n` +
    '```\n' + wsUrl + '\n```\n\n' +
    `🔐 *配對碼:*\n` +
    '```\n' + code + '\n```\n\n' +
    `_在 Electron 桌面客戶端貼上即可連線_\n` +
    `_配對碼 5 分鐘後過期_\n\n` +
    `${networkNote}`,
    { parse_mode: 'Markdown' },
  )
}

async function pairBatCommand(ctx: BotContext, chatId: number, threadId: number | undefined): Promise<void> {
  // The host must have its own BAT credentials in env — that's what the relay
  // hands back. Warn early instead of issuing a code that can't be redeemed.
  if (!env.BAT_REMOTE_URL || !env.BAT_REMOTE_TOKEN || !env.BAT_REMOTE_FINGERPRINT) {
    await ctx.reply(
      '⚠️ 這台主機尚未設定 BAT 憑證。\n' +
      '請先在主機 `.env` 填入 `BAT_REMOTE_URL` / `BAT_REMOTE_TOKEN` / `BAT_REMOTE_FINGERPRINT`（可從 BAT 的 Settings → Remote 取得），再執行 /pair bat。',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const code = createPairingCode(chatId, threadId, 'bat')
  const { url: wsUrl, isPublic } = getRelayUrl()

  const networkNote = isPublic
    ? '🌐 公開 URL — 跨網路可用'
    : '🏠 區網 URL — 需同個 WiFi（設 `RELAY_TUNNEL=true` 開啟跨網路）'

  await ctx.reply(
    `🤖 *BAT 遠端配對*\n\n` +
    `在新機器的 ClaudeBot 目錄執行這行，即可自動取得並保存 BAT 憑證：\n` +
    '```\n' +
    `npx tsx src/remote/join-bat.ts ${wsUrl} ${code}\n` +
    '```\n\n' +
    `完成後把該專案的 AI 後端切成 \`bat-remote\` 即可使用。\n` +
    `_配對碼 5 分鐘後過期，且只能領取一次_\n\n` +
    `${networkNote}`,
    { parse_mode: 'Markdown' },
  )
}

export async function unpairCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const arg = text.split(/\s+/).slice(1).join(' ').trim()

  // /unpair all → remove all machines
  if (arg.toLowerCase() === 'all') {
    const removed = removePairing(chatId, threadId)
    if (removed) {
      setActiveMachine(chatId, undefined, threadId)
      await ctx.reply('🔌 已斷開所有遠端配對。')
    } else {
      await ctx.reply('目前沒有配對的遠端連線。')
    }
    return
  }

  // /unpair <label> → remove specific machine
  if (arg) {
    const removed = removePairing(chatId, threadId, arg)
    if (removed) {
      const activeMch = getActiveMachine(chatId, threadId)
      if (activeMch === arg) {
        // Active machine was removed — switch to first remaining connected
        const remaining = getPairings(chatId, threadId).filter((s) => s.connected)
        setActiveMachine(chatId, remaining[0]?.label, threadId)
      }
      await ctx.reply(`🔌 已斷開 ${arg}`)
    } else {
      await ctx.reply(`找不到機器 "${arg}"。用 /machines 查看已配對機器。`)
    }
    return
  }

  // /unpair (no args) → show selection if multiple, otherwise remove all
  const pairings = getPairings(chatId, threadId)
  if (pairings.length === 0) {
    await ctx.reply('目前沒有配對的遠端連線。')
    return
  }

  if (pairings.length === 1) {
    removePairing(chatId, threadId)
    setActiveMachine(chatId, undefined, threadId)
    await ctx.reply(`🔌 已斷開 ${pairings[0].label || 'remote'}`)
    return
  }

  // Multiple machines — show inline buttons
  const buttons = [
    ...pairings.map((s) => {
      const label = s.label || s.code
      const icon = s.connected ? '🔗' : '⭕'
      return [Markup.button.callback(`${icon} ${label}`, `unpair:${label}`)]
    }),
    [Markup.button.callback('🔌 全部斷開', 'unpair:__all__')],
  ]

  await ctx.reply(
    '選擇要斷開的機器:',
    Markup.inlineKeyboard(buttons),
  )
}
