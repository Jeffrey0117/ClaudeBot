import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

async function diceCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/dice\s*/, '').trim()

  // /dice → roll 1 die
  // /dice 3 → roll 3 dice
  // /dice 1-100 → random number in range
  const rangeMatch = args.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const min = parseInt(rangeMatch[1], 10)
    const max = parseInt(rangeMatch[2], 10)
    if (min >= max) {
      await ctx.reply('❌ 範圍無效，最小值必須小於最大值')
      return
    }
    const result = Math.floor(Math.random() * (max - min + 1)) + min
    await ctx.reply(`🎲 ${min}–${max} → **${result}**`, { parse_mode: 'Markdown' })
    return
  }

  const count = Math.min(Math.max(parseInt(args, 10) || 1, 1), 10)
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * 6))
  const faces = rolls.map((r) => DICE_FACES[r]).join(' ')
  const values = rolls.map((r) => r + 1)
  const total = values.reduce((a, b) => a + b, 0)

  const result = count === 1
    ? `🎲 ${faces}  →  **${values[0]}**`
    : `🎲 ${faces}\n合計: **${total}** (${values.join(' + ')})`

  await ctx.reply(result, { parse_mode: 'Markdown' })
}

async function coinCommand(ctx: BotContext): Promise<void> {
  const result = Math.random() < 0.5 ? '🪙 正面 (Heads)' : '🪙 反面 (Tails)'
  await ctx.reply(result)
}

const dicePlugin: Plugin = {
  name: 'dice',
  description: '骰子與隨機數',
  commands: [
    {
      name: 'dice',
      description: '擲骰子 (1-10顆/範圍)',
      handler: diceCommand,
    },
    {
      name: 'coin',
      description: '擲硬幣',
      handler: coinCommand,
    },
  ],
}

export default dicePlugin
