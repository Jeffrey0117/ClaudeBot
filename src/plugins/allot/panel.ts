/**
 * Allot Plugin — Telegram inline panel builder.
 */

import { Markup } from 'telegraf'
import type { AllotConfig, RemoteQuotaState, HistoryEntry } from './types.js'
import { RATE_WINDOW_MS } from './types.js'
import { getStore } from './allot-store.js'
import {
  countConnectedRemotes,
  perRemoteRateBudget,
  perRemoteWeeklyBudget,
  weeklyUsagePercent,
  rateUsedTurns,
} from './quota-engine.js'

export interface PanelResult {
  readonly text: string
  readonly keyboard: ReturnType<typeof Markup.inlineKeyboard>
}

function progressBar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return '\u{2588}'.repeat(filled) + '\u{2591}'.repeat(width - filled)
}

function statusEmoji(pct: number): string {
  if (pct >= 95) return '\u{1F534}'
  if (pct >= 85) return '\u{26A0}\u{FE0F}'
  if (pct > 0) return '\u{2705}'
  return '\u{1F4A4}'
}

/** Build the main /allot panel */
export function buildMainPanel(): PanelResult {
  const data = getStore().load()
  const config = data.config
  const remoteCount = countConnectedRemotes()

  const onOff = config.enabled ? '\u{1F7E2} \u{555F}\u{7528}' : '\u{1F534} \u{505C}\u{7528}'
  const modeLabel = config.mode === 'auto' ? '\u{81EA}\u{9069}\u{61C9}' : '\u{624B}\u{52D5}'

  const ratio = config.ratioPercent ?? 20
  const totalUsed = ratio * remoteCount
  const totalWarn = totalUsed > 80 ? ' \u{26A0}\u{FE0F}' : ''

  const lines = [
    '\u{1F4CA} *Allot \u{984D}\u{5EA6}\u{7BA1}\u{7406}\u{9762}\u{677F}*',
    '',
    `${onOff} | \u{2699}\u{FE0F} ${modeLabel} | \u{1F465} Remote: ${remoteCount}`,
    `\u{1F4B0} \u{6BCF}\u{53F0}: ${ratio}% | \u{7E3D}\u{4F54}: ${totalUsed}%${totalWarn}`,
    '',
    `\u{23F1} Rate: ${config.rateBudget}t/5min \u{00D7} ${ratio}% = \u{6BCF}\u{53F0} ${perRemoteRateBudget(config)}t`,
    `\u{1F4C5} Weekly: ${config.weeklyBudget}t/wk \u{00D7} ${ratio}% = \u{6BCF}\u{53F0} ${perRemoteWeeklyBudget(config)}t`,
    `\u{1F4CA} \u{908A}\u{969B}: ${config.marginPercent}% | \u{9810}\u{7559}: ${config.reserveAmount}t/req`,
  ]

  // Per-remote status (from shared store — all bots)
  const remotes = Object.values(data.remotes)
  const cutoff = Date.now() - RATE_WINDOW_MS
  const activeRemotes = remotes.filter(
    (r) => r.pendingReserve > 0 || r.rateUsage.some((u) => u.timestamp >= cutoff),
  )
  if (activeRemotes.length > 0) {
    lines.push('')
    for (const remote of activeRemotes) {
      const rUsed = rateUsedTurns(remote)
      const rBudget = perRemoteRateBudget(config)
      const wPct = weeklyUsagePercent(remote, config)
      const emoji = statusEmoji(wPct)
      const label = remote.label || remote.id.slice(-6)
      lines.push(`\u{1F4F1} ${label}: ${rUsed}/${rBudget}t ${progressBar(wPct)} ${emoji}`)
    }
  } else if (config.enabled) {
    lines.push('')
    lines.push('\u{1F4AD} \u{7121}\u{9060}\u{7AEF}\u{9023}\u{7DDA}')
  }

  // 429 info
  if (config.last429At) {
    const ago = Math.round((Date.now() - config.last429At) / 60000)
    lines.push('')
    lines.push(`\u{26A1} \u{4E0A}\u{6B21} 429: ${ago} \u{5206}\u{9418}\u{524D}`)
  }

  const toggleLabel = config.enabled
    ? '\u{1F534} \u{505C}\u{7528}'
    : '\u{1F7E2} \u{555F}\u{7528}'
  const modeToggle = config.mode === 'auto'
    ? '\u{1F4D0} \u{5207}\u{624B}\u{52D5}'
    : '\u{1F916} \u{5207}\u{81EA}\u{9069}\u{61C9}'

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(toggleLabel, 'allot:toggle'),
      Markup.button.callback(modeToggle, 'allot:mode'),
    ],
    [
      Markup.button.callback('\u{1F4C8} Ratio+10', 'allot:ratio_up'),
      Markup.button.callback('\u{1F4C9} Ratio-10', 'allot:ratio_down'),
    ],
    [
      Markup.button.callback('\u{1F4C8} Rate+5', 'allot:rate_up'),
      Markup.button.callback('\u{1F4C9} Rate-5', 'allot:rate_down'),
    ],
    [
      Markup.button.callback('\u{1F4C8} Wk+100', 'allot:weekly_up'),
      Markup.button.callback('\u{1F4C9} Wk-100', 'allot:weekly_down'),
    ],
    [
      Markup.button.callback('\u{1F4CB} \u{6B77}\u{53F2}', 'allot:history'),
      Markup.button.callback('\u{1F504} \u{91CD}\u{6574}', 'allot:refresh'),
    ],
  ])

  return { text: lines.join('\n'), keyboard }
}

/** Build history panel */
export function buildHistoryPanel(): PanelResult {
  const data = getStore().load()
  const recent = data.history.slice(-20).reverse()

  if (recent.length === 0) {
    return {
      text: '\u{1F4CB} *Allot \u{6B77}\u{53F2}\u{7D00}\u{9304}*\n\n\u{7121}\u{7D00}\u{9304}',
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('\u{2B05}\u{FE0F} \u{8FD4}\u{56DE}', 'allot:refresh')],
      ]),
    }
  }

  const typeLabels: Record<string, string> = {
    reserve: '\u{1F4E5}',
    settle: '\u{1F4E4}',
    reject: '\u{1F6AB}',
    warn: '\u{26A0}\u{FE0F}',
    '429': '\u{26A1}',
    adjust: '\u{1F4CA}',
  }

  const lines = ['\u{1F4CB} *Allot \u{6B77}\u{53F2}\u{7D00}\u{9304}*', '']
  for (const entry of recent) {
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-TW', { hour12: false })
    const icon = typeLabels[entry.type] ?? '\u{2022}'
    const rid = entry.remoteId === 'system' ? 'sys' : entry.remoteId.slice(-6)
    lines.push(`${icon} ${time} [${rid}] ${entry.detail}`)
  }

  return {
    text: lines.join('\n'),
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('\u{2B05}\u{FE0F} \u{8FD4}\u{56DE}', 'allot:refresh')],
    ]),
  }
}
