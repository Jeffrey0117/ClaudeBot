import type { BotContext } from '../../types/context.js'
import { getSystemPrompt, reloadSystemPrompt } from '../../utils/system-prompt.js'

export async function promptCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const arg = text.replace(/^\/prompt\s*/, '').trim()

  if (arg === 'reload') {
    const prompt = reloadSystemPrompt()
    if (!prompt) {
      await ctx.reply('⚠️ System prompt 檔案為空或不存在。')
      return
    }
    await ctx.reply('✅ System prompt 已重新載入。')
    return
  }

  const prompt = getSystemPrompt()
  if (!prompt) {
    await ctx.reply('⚠️ 目前沒有設定 system prompt。\n檔案位置: `data/system-prompt.md`', { parse_mode: 'Markdown' })
    return
  }

  const preview = prompt.length > 3500
    ? prompt.slice(0, 3500) + '\n\n... (truncated)'
    : prompt

  await ctx.reply(`📋 *System Prompt*\n\n${preview}\n\n---\n/prompt reload — 重新載入`, { parse_mode: 'Markdown' })
}
