import type { BotContext } from '../../types/context.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'
import { callAgentTool } from '../../remote/relay-server.js'
import { sniff, type SniffResult } from '../vision/sniffer.js'
import { splitText } from '../../utils/text-splitter.js'
import { validateUrl } from '../../utils/validate-url.js'

function formatSniff(r: SniffResult): string {
  if (r.calls.length === 0) {
    return `🔎 sniff: ${r.pageUrl}\n沒攔到 JSON API（可能是純靜態頁，或資料走 SSR/WebSocket）。過濾掉 ${r.droppedCount} 個非 JSON。`
  }
  const head = `🔎 sniff: ${r.pageUrl}（${(r.capturedMs / 1000).toFixed(1)}s，捕獲 ${r.calls.length} 個 API，過濾掉 ${r.droppedCount} 個非 JSON）\n`
  const body = r.calls.map((c, i) => {
    const kb = c.bodyBytes >= 1024 ? `${(c.bodyBytes / 1024).toFixed(1)} KB` : `${c.bodyBytes} B`
    return `\n${i + 1}. ${c.method} ${c.url}\n   ${c.status} · ${c.mimeType} · ${kb}\n   ${c.bodyPreview}`
  }).join('\n')
  return head + body
}

export async function sniffCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message?.message_thread_id
  const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '')
    .replace(/^\/sniff(@\S+)?\s*/i, '').trim()

  const parts = text.split(/\s+/).filter(Boolean)
  const url = parts[0]
  const seconds = parts[1] ? Number(parts[1]) : 8
  if (!url || !/^https?:\/\//i.test(url)) {
    await ctx.reply('用法: /sniff <url> [秒數]\n例: /sniff https://example.com 8')
    return
  }
  // SSRF guard — applies to BOTH the local and remote paths (block internal/
  // private hosts so /sniff can't be pointed at localhost / RFC1918 / metadata).
  try {
    validateUrl(url)
  } catch {
    await ctx.reply('❌ 不允許內部/私有網址')
    return
  }

  const secs = Math.min(20, Math.max(3, seconds))
  await ctx.reply(`🔎 開始 sniff ${url}（約 ${secs}s）…`)

  try {
    const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
    let result: SniffResult
    if (pairing?.connected) {
      // Timeout scaled to the actual capture window + overhead (avoids a silent
      // double-wait if a fixed timeout fires mid-capture and the relay retries).
      const raw = await callAgentTool(pairing.code, 'remote_browser_sniff', { url, seconds }, secs * 1000 + 20_000)
      result = JSON.parse(raw) as SniffResult
    } else {
      result = await sniff(url, seconds)
    }
    for (const chunk of splitText(formatSniff(result))) {
      await ctx.reply(chunk)
    }
  } catch (error) {
    await ctx.reply(`❌ sniff 失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}
