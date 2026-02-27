import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'

export async function newbotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const msg = ctx.message
  if (!msg || !('text' in msg)) return

  const args = msg.text.replace(/^\/newbot\s*/, '').trim()
  if (!args) {
    await ctx.reply(
      '用法: `/newbot <BOT_TOKEN> [PASSWORD]`\n\n' +
      '1. 先去 @BotFather 建立 bot 拿 token\n' +
      '2. 貼上 token，自動建立 .env 並上線\n\n' +
      '範例: `/newbot 123456:ABCdef my_password`',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const parts = args.split(/\s+/)
  const token = parts[0]
  const password = parts[1] || env.LOGIN_PASSWORD || 'changeme'

  // Validate token format (roughly: digits:alphanumeric)
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    await ctx.reply('❌ Token 格式不對，應該像 `123456789:ABCdefGHIjklMNO`', { parse_mode: 'Markdown' })
    return
  }

  // Check not duplicating current bot's token
  if (token === env.BOT_TOKEN) {
    await ctx.reply('❌ 這是目前 bot 自己的 token')
    return
  }

  // Find next available .env.botN
  const root = process.cwd()
  const existing = readdirSync(root)
    .filter((f) => /^\.env\.bot\d+$/.test(f))
    .map((f) => {
      const match = f.match(/^\.env\.bot(\d+)$/)
      return match ? parseInt(match[1], 10) : 0
    })

  const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 2
  const filename = `.env.bot${nextNum}`
  const filepath = path.join(root, filename)

  // Build env content from current bot's config as template
  const lines = [
    `BOT_TOKEN=${token}`,
    `LOGIN_PASSWORD=${password}`,
    `ALLOWED_CHAT_IDS=${env.ALLOWED_CHAT_IDS.join(',')}`,
    `PROJECTS_BASE_DIR=${env.PROJECTS_BASE_DIR.join(',')}`,
    `DEFAULT_MODEL=${env.DEFAULT_MODEL}`,
    `RATE_LIMIT_MAX=${env.RATE_LIMIT_MAX}`,
    `RATE_LIMIT_WINDOW_MS=${env.RATE_LIMIT_WINDOW_MS}`,
    `PLUGINS=${env.PLUGINS.join(',')}`,
  ]

  writeFileSync(filepath, lines.join('\n') + '\n', 'utf-8')

  // Verify the bot token by calling Telegram getMe
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    })
    const data = await res.json() as { ok: boolean; result?: { username?: string; first_name?: string } }

    if (data.ok && data.result) {
      const botName = data.result.username ? `@${data.result.username}` : data.result.first_name || '未知'

      await ctx.reply(
        `✅ 新 bot 設定完成！\n\n` +
        `*檔案:* \`${filename}\`\n` +
        `*Bot:* ${botName}\n` +
        `*密碼:* \`${password}\`\n\n` +
        `用 /restart 重啟 launcher 讓新 bot 上線`,
        { parse_mode: 'Markdown' },
      )
    } else {
      await ctx.reply(
        `⚠️ 已建立 \`${filename}\`，但 token 驗證失敗\n` +
        '請確認 token 是否正確，再用 /restart 重啟',
        { parse_mode: 'Markdown' },
      )
    }
  } catch {
    await ctx.reply(
      `⚠️ 已建立 \`${filename}\`，但無法驗證 token（網路問題？）\n` +
      '用 /restart 重啟試試',
      { parse_mode: 'Markdown' },
    )
  }
}
