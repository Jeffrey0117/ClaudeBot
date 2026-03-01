import type { BotContext } from '../../types/context.js'
import { WebSocket } from 'ws'
import {
  setPairing,
  getPairing,
  removePairing,
} from '../../remote/pairing-store.js'
import type { PairRequest, AgentResponse } from '../../remote/protocol.js'

const PAIR_RE = /^(\d{6})@([\w.\-:[\]]+:\d{1,5})$/

export async function pairCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const arg = text.split(' ').slice(1).join(' ').trim()

  if (!arg) {
    const threadId = ctx.message?.message_thread_id
    const current = getPairing(chatId, threadId)
    if (current) {
      const elapsed = ((Date.now() - current.connectedAt) / 1000 / 60).toFixed(0)
      await ctx.reply(
        `🔗 *已配對* ${current.label}\n` +
        `已連線 ${elapsed} 分鐘\n\n` +
        `用 /unpair 斷開`,
        { parse_mode: 'Markdown' },
      )
    } else {
      await ctx.reply(
        '用法: `/pair <6碼配對碼>@<IP:端口>`\n' +
        '例: `/pair 482913@192.168.1.50:9876`\n\n' +
        '在對方電腦執行:\n' +
        '`npx tsx src/remote/agent.ts`',
        { parse_mode: 'Markdown' },
      )
    }
    return
  }

  const match = arg.match(PAIR_RE)
  if (!match) {
    await ctx.reply(
      '❌ 格式錯誤\n\n' +
      '正確格式: `/pair <6碼>@<IP:端口>`\n' +
      '例: `/pair 482913@192.168.1.50:9876`',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const code = match[1]
  const address = match[2]
  const wsUrl = `ws://${address}`

  const ack = await ctx.reply(`⏳ 正在連線 ${address}...`)

  try {
    await validatePairing(wsUrl, code)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.telegram.editMessageText(
      chatId, ack.message_id, undefined,
      `❌ 配對失敗: ${msg}`,
    )
    return
  }

  const threadId = ctx.message?.message_thread_id
  setPairing(chatId, threadId, {
    wsUrl,
    code,
    connectedAt: Date.now(),
    label: address,
  })

  await ctx.telegram.editMessageText(
    chatId, ack.message_id, undefined,
    `✅ *已配對* ${address}\n\n` +
    `遠端工具已啟用，Claude 現在可以讀寫對方電腦的檔案。\n` +
    `用 /unpair 斷開連線。`,
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

function validatePairing(wsUrl: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('連線逾時 (5秒)'))
    }, 5_000)

    socket.on('open', () => {
      const msg: PairRequest = { type: 'pair', code }
      socket.send(JSON.stringify(msg))
    })

    socket.on('message', (raw) => {
      clearTimeout(timer)
      try {
        const msg = JSON.parse(raw.toString()) as AgentResponse
        socket.close()
        if (msg.type === 'pair_ok') {
          resolve()
        } else if (msg.type === 'pair_fail') {
          reject(new Error(msg.error || '配對碼錯誤'))
        } else {
          reject(new Error('Unexpected response'))
        }
      } catch (err) {
        socket.close()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`連線失敗: ${err.message}`))
    })
  })
}
