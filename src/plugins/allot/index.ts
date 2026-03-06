/**
 * Allot Plugin — Remote quota management.
 *
 * Dual-layer sliding-window quota system:
 *   Layer 1: Rate limit (5-min, auto-adaptive)
 *   Layer 2: Weekly limit (7-day, manual + 70/85/95% warnings)
 *
 * Local requests are NEVER blocked. Only remote pairing connections
 * are subject to quota enforcement.
 */

import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'
import { getStore, updateConfig, resetRemoteUsage } from './allot-store.js'
import { buildMainPanel, buildHistoryPanel } from './panel.js'
import {
  tryReserve,
  settle,
  on429Detected,
  adaptiveTick,
  pruneExpiredRecords,
} from './quota-engine.js'
import { RATE_WINDOW_MS } from './types.js'

// Re-export for integration hooks (via getPluginModule)
export { tryReserve, settle, on429Detected }

// ---------------------------------------------------------------------------
// Service intervals
// ---------------------------------------------------------------------------

let adaptiveTimer: ReturnType<typeof setInterval> | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// /allot command
// ---------------------------------------------------------------------------

async function allotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId || (env.ADMIN_CHAT_ID && chatId !== env.ADMIN_CHAT_ID)) {
    await ctx.reply('\u{1F6AB} \u{50C5}\u{9650}\u{7BA1}\u{7406}\u{54E1}\u{4F7F}\u{7528}')
    return
  }

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = text.replace(/^\/allot\s*/i, '').trim()

  if (!args) {
    const panel = buildMainPanel()
    await ctx.reply(panel.text, { parse_mode: 'Markdown', ...panel.keyboard })
    return
  }

  const parts = args.split(/\s+/)
  const sub = parts[0].toLowerCase()

  switch (sub) {
    case 'on':
      updateConfig({ enabled: true })
      await ctx.reply('\u{1F7E2} Allot \u{5DF2}\u{555F}\u{7528}')
      break

    case 'off':
      updateConfig({ enabled: false })
      await ctx.reply('\u{1F534} Allot \u{5DF2}\u{505C}\u{7528}')
      break

    case 'auto':
      updateConfig({ mode: 'auto' })
      await ctx.reply('\u{1F916} \u{5DF2}\u{5207}\u{63DB}\u{70BA}\u{81EA}\u{9069}\u{61C9}\u{6A21}\u{5F0F}')
      break

    case 'set': {
      const n = parseInt(parts[1], 10)
      if (isNaN(n) || n < 1) {
        await ctx.reply('\u{26A0}\u{FE0F} \u{7528}\u{6CD5}: /allot set <N>')
        break
      }
      updateConfig({ rateBudget: n, mode: 'manual' })
      await ctx.reply(`\u{1F4D0} Rate \u{9810}\u{7B97}\u{5DF2}\u{8A2D}\u{70BA} ${n} turns (\u{624B}\u{52D5}\u{6A21}\u{5F0F})`)
      break
    }

    case 'weekly': {
      const w = parseInt(parts[1], 10)
      if (isNaN(w) || w < 1) {
        await ctx.reply('\u{26A0}\u{FE0F} \u{7528}\u{6CD5}: /allot weekly <N>')
        break
      }
      updateConfig({ weeklyBudget: w })
      await ctx.reply(`\u{1F4C5} Weekly \u{9810}\u{7B97}\u{5DF2}\u{8A2D}\u{70BA} ${w} turns`)
      break
    }

    case 'ratio': {
      const r = parseInt(parts[1], 10)
      if (isNaN(r) || r < 5 || r > 95) {
        await ctx.reply('\u{26A0}\u{FE0F} \u{7528}\u{6CD5}: /allot ratio <5-95>')
        break
      }
      updateConfig({ ratioPercent: r })
      await ctx.reply(`\u{1F4B0} \u{6BCF}\u{53F0}\u{9060}\u{7AEF}\u{4F54}\u{6BD4}\u{5DF2}\u{8A2D}\u{70BA} ${r}%`)
      break
    }

    case 'margin': {
      const m = parseInt(parts[1], 10)
      if (isNaN(m) || m < 0 || m > 50) {
        await ctx.reply('\u{26A0}\u{FE0F} \u{7528}\u{6CD5}: /allot margin <0-50>')
        break
      }
      updateConfig({ marginPercent: m })
      await ctx.reply(`\u{1F4CA} \u{908A}\u{969B}\u{5DF2}\u{8A2D}\u{70BA} ${m}%`)
      break
    }

    case 'reset': {
      const targetId = parts[1]
      if (!targetId) {
        await ctx.reply('\u{26A0}\u{FE0F} \u{7528}\u{6CD5}: /allot reset <remote-id>')
        break
      }
      resetRemoteUsage(targetId)
      await ctx.reply(`\u{1F504} \u{5DF2}\u{91CD}\u{7F6E} ${targetId} \u{7684}\u{4F7F}\u{7528}\u{8A18}\u{9304}`)
      break
    }

    case 'history': {
      const panel = buildHistoryPanel()
      await ctx.reply(panel.text, { parse_mode: 'Markdown', ...panel.keyboard })
      break
    }

    default:
      await ctx.reply(
        '\u{26A0}\u{FE0F} \u{672A}\u{77E5}\u{6307}\u{4EE4}\n\n'
        + '\u{7528}\u{6CD5}:\n'
        + '`/allot` \u{2014} \u{6253}\u{958B}\u{9762}\u{677F}\n'
        + '`/allot on|off` \u{2014} \u{555F}\u{7528}/\u{505C}\u{7528}\n'
        + '`/allot auto` \u{2014} \u{81EA}\u{9069}\u{61C9}\u{6A21}\u{5F0F}\n'
        + '`/allot ratio <5-95>` \u{2014} \u{9060}\u{7AEF}\u{4F54}\u{6BD4} %\n'
        + '`/allot set <N>` \u{2014} \u{8A2D}\u{5B9A} Rate \u{9810}\u{7B97}\n'
        + '`/allot weekly <N>` \u{2014} \u{8A2D}\u{5B9A}\u{6BCF}\u{9031}\u{9810}\u{7B97}\n'
        + '`/allot margin <0-50>` \u{2014} \u{908A}\u{969B}\u{767E}\u{5206}\u{6BD4}\n'
        + '`/allot reset <id>` \u{2014} \u{91CD}\u{7F6E}\u{4F7F}\u{7528}\u{8A18}\u{9304}\n'
        + '`/allot history` \u{2014} \u{67E5}\u{770B}\u{6B77}\u{53F2}',
        { parse_mode: 'Markdown' },
      )
  }
}

// ---------------------------------------------------------------------------
// Callback handler
// ---------------------------------------------------------------------------

async function handleCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('allot:')) return false

  const callerId = ctx.callbackQuery && 'from' in ctx.callbackQuery ? ctx.callbackQuery.from.id : 0
  if (env.ADMIN_CHAT_ID && callerId !== env.ADMIN_CHAT_ID) {
    await ctx.answerCbQuery('\u{1F6AB} \u{50C5}\u{9650}\u{7BA1}\u{7406}\u{54E1}')
    return true
  }

  const action = data.slice('allot:'.length)

  switch (action) {
    case 'toggle': {
      const current = getStore().load().config.enabled
      updateConfig({ enabled: !current })
      break
    }
    case 'mode': {
      const mode = getStore().load().config.mode
      updateConfig({ mode: mode === 'auto' ? 'manual' : 'auto' })
      break
    }
    case 'ratio_up':
      updateConfig({ ratioPercent: Math.min(95, (getStore().load().config.ratioPercent ?? 20) + 10) })
      break
    case 'ratio_down':
      updateConfig({ ratioPercent: Math.max(5, (getStore().load().config.ratioPercent ?? 20) - 10) })
      break
    case 'rate_up':
      updateConfig({ rateBudget: getStore().load().config.rateBudget + 5 })
      break
    case 'rate_down':
      updateConfig({ rateBudget: Math.max(5, getStore().load().config.rateBudget - 5) })
      break
    case 'weekly_up':
      updateConfig({ weeklyBudget: getStore().load().config.weeklyBudget + 100 })
      break
    case 'weekly_down':
      updateConfig({ weeklyBudget: Math.max(100, getStore().load().config.weeklyBudget - 100) })
      break
    case 'history': {
      const panel = buildHistoryPanel()
      try {
        await ctx.editMessageText(panel.text, { parse_mode: 'Markdown', ...panel.keyboard })
      } catch { /* message unchanged */ }
      await ctx.answerCbQuery()
      return true
    }
    case 'refresh':
      break // just refresh the panel below
    default:
      await ctx.answerCbQuery('Unknown action')
      return true
  }

  // Refresh panel after state change
  const panel = buildMainPanel()
  try {
    await ctx.editMessageText(panel.text, { parse_mode: 'Markdown', ...panel.keyboard })
  } catch { /* message unchanged */ }
  await ctx.answerCbQuery()
  return true
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const allotPlugin: Plugin = {
  name: 'allot',
  description: 'Remote \u{984D}\u{5EA6}\u{7BA1}\u{7406}',
  commands: [
    {
      name: 'allot',
      description: '\u{7BA1}\u{7406} Remote \u{9023}\u{7DDA}\u{984D}\u{5EA6}',
      handler: allotCommand,
    },
  ],
  onCallback: handleCallback,
  service: {
    start: async () => {
      // Adaptive tick every rate window (5 min)
      adaptiveTimer = setInterval(adaptiveTick, RATE_WINDOW_MS)
      // Prune expired records every 10 min
      pruneTimer = setInterval(pruneExpiredRecords, 10 * 60 * 1000)
    },
    stop: async () => {
      if (adaptiveTimer) { clearInterval(adaptiveTimer); adaptiveTimer = null }
      if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
    },
  },
  cleanup: async () => {
    if (adaptiveTimer) { clearInterval(adaptiveTimer); adaptiveTimer = null }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
  },
}

export default allotPlugin
