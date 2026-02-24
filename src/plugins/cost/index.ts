import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import type { AIBackend } from '../../ai/types.js'
import { env } from '../../config/env.js'

// --- In-memory cost ledger ---

interface CostEntry {
  readonly timestamp: number
  readonly costUsd: number
  readonly backend: AIBackend
  readonly model: string
  readonly project: string
  readonly durationMs: number
  readonly toolCount: number
}

const ledger: CostEntry[] = []

export function recordCost(entry: CostEntry): void {
  ledger.push(entry)
}

function getTodayEntries(): readonly CostEntry[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return ledger.filter((e) => e.timestamp >= todayStart)
}

function formatUsd(amount: number): string {
  return amount < 0.01
    ? `$${amount.toFixed(4)}`
    : `$${amount.toFixed(2)}`
}

function getTopModels(entries: readonly CostEntry[]): readonly { label: string; cost: number; count: number }[] {
  const map = new Map<string, { cost: number; count: number }>()
  for (const e of entries) {
    const key = `${e.backend}/${e.model}`
    const existing = map.get(key) ?? { cost: 0, count: 0 }
    map.set(key, {
      cost: existing.cost + e.costUsd,
      count: existing.count + 1,
    })
  }
  return [...map.entries()]
    .map(([label, { cost, count }]) => ({ label, cost, count }))
    .sort((a, b) => b.cost - a.cost)
}

function getTopProjects(entries: readonly CostEntry[]): readonly { project: string; cost: number; count: number }[] {
  const map = new Map<string, { cost: number; count: number }>()
  for (const e of entries) {
    const existing = map.get(e.project) ?? { cost: 0, count: 0 }
    map.set(e.project, {
      cost: existing.cost + e.costUsd,
      count: existing.count + 1,
    })
  }
  return [...map.entries()]
    .map(([project, { cost, count }]) => ({ project, cost, count }))
    .sort((a, b) => b.cost - a.cost)
}

// --- /cost command ---

async function costCommand(ctx: BotContext): Promise<void> {
  const todayEntries = getTodayEntries()
  const todayCost = todayEntries.reduce((sum, e) => sum + e.costUsd, 0)
  const totalCost = ledger.reduce((sum, e) => sum + e.costUsd, 0)
  const totalCalls = ledger.length
  const todayCalls = todayEntries.length

  if (totalCalls === 0) {
    await ctx.reply('📊 尚無花費記錄（重啟後清零）')
    return
  }

  const source = todayEntries.length > 0 ? todayEntries : ledger
  const label = todayEntries.length > 0 ? '今日' : '累計'

  const lines: string[] = [
    '📊 *費用面板*',
    '',
    `*今日:* ${formatUsd(todayCost)} (${todayCalls} 次呼叫)`,
    `*累計:* ${formatUsd(totalCost)} (${totalCalls} 次呼叫)`,
  ]

  // Model breakdown
  const models = getTopModels(source)
  if (models.length > 0) {
    lines.push('')
    lines.push(`*${label}模型分佈:*`)
    for (const m of models) {
      lines.push(`  ${m.label}: ${formatUsd(m.cost)} (${m.count}次)`)
    }
  }

  // Project breakdown (top 5)
  const projects = getTopProjects(source)
  if (projects.length > 1) {
    lines.push('')
    lines.push(`*${label}專案分佈:*`)
    for (const p of projects.slice(0, 5)) {
      lines.push(`  ${p.project}: ${formatUsd(p.cost)} (${p.count}次)`)
    }
  }

  // Average cost per call
  const avgCost = source.reduce((sum, e) => sum + e.costUsd, 0) / source.length
  const avgDuration = source.reduce((sum, e) => sum + e.durationMs, 0) / source.length
  lines.push('')
  lines.push(`*平均:* ${formatUsd(avgCost)}/次 | ${(avgDuration / 1000).toFixed(1)}秒/次`)

  // Last 3 calls
  const recent = ledger.slice(-3).reverse()
  if (recent.length > 0) {
    lines.push('')
    lines.push('*最近呼叫:*')
    for (const e of recent) {
      const time = new Date(e.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
      lines.push(`  ${time} ${e.project} (${e.backend}/${e.model}) ${formatUsd(e.costUsd)}`)
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

// --- /usage command (Anthropic Admin API) ---

interface CostBucket {
  readonly started_at: string
  readonly ended_at: string
  readonly cost_tokens_usd: string
  readonly cost_web_search_usd: string
  readonly cost_code_execution_usd: string
}

interface CostResponse {
  readonly data: readonly CostBucket[]
}

async function usageCommand(ctx: BotContext): Promise<void> {
  const adminKey = env.ANTHROPIC_ADMIN_KEY
  if (!adminKey) {
    await ctx.reply(
      '⚠️ 需要設定 `ANTHROPIC_ADMIN_KEY` 環境變數\n\n' +
      '到 Anthropic Console → Settings → Admin API Keys 建立',
      { parse_mode: 'Markdown' },
    )
    return
  }

  await ctx.reply('⏳ 查詢 Anthropic API 用量中...')

  try {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startStr = startOfMonth.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const endStr = now.toISOString().replace(/\.\d{3}Z$/, 'Z')

    const costRes = await fetchAnthropicApi<CostResponse>(
      adminKey,
      `/v1/organizations/cost?starting_at=${startStr}&ending_at=${endStr}&bucket_width=1d`,
    )

    const lines: string[] = ['📈 *Anthropic API 本月用量*', '']

    if (costRes?.data && costRes.data.length > 0) {
      const totalTokenCost = costRes.data.reduce(
        (sum, b) => sum + parseFloat(b.cost_tokens_usd || '0'), 0,
      )
      const totalSearchCost = costRes.data.reduce(
        (sum, b) => sum + parseFloat(b.cost_web_search_usd || '0'), 0,
      )
      const totalCodeCost = costRes.data.reduce(
        (sum, b) => sum + parseFloat(b.cost_code_execution_usd || '0'), 0,
      )
      const grandTotal = totalTokenCost + totalSearchCost + totalCodeCost

      lines.push(`*總費用:* $${grandTotal.toFixed(2)}`)
      lines.push(`  Token: $${totalTokenCost.toFixed(2)}`)
      if (totalSearchCost > 0) lines.push(`  Web Search: $${totalSearchCost.toFixed(2)}`)
      if (totalCodeCost > 0) lines.push(`  Code Exec: $${totalCodeCost.toFixed(2)}`)

      // Daily breakdown (last 7 days)
      const recentDays = costRes.data.slice(-7)
      if (recentDays.length > 1) {
        lines.push('')
        lines.push('*近 7 日:*')
        for (const day of recentDays) {
          const date = new Date(day.started_at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
          const dayCost = parseFloat(day.cost_tokens_usd || '0') +
            parseFloat(day.cost_web_search_usd || '0') +
            parseFloat(day.cost_code_execution_usd || '0')
          if (dayCost > 0) {
            lines.push(`  ${date}: $${dayCost.toFixed(2)}`)
          }
        }
      }
    } else {
      lines.push('本月尚無消費記錄')
    }

    lines.push('')
    lines.push(`_期間: ${startOfMonth.toLocaleDateString('zh-TW')} ~ ${now.toLocaleDateString('zh-TW')}_`)

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ 查詢失敗: \`${msg}\``, { parse_mode: 'Markdown' })
  }
}

async function fetchAnthropicApi<T>(adminKey: string, path: string): Promise<T> {
  const url = `https://api.anthropic.com${path}`
  const response = await fetch(url, {
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`API ${response.status}: ${body.slice(0, 200)}`)
  }

  return response.json() as Promise<T>
}

// --- Plugin export ---

const costPlugin: Plugin = {
  name: 'cost',
  description: '費用追蹤與用量查詢',
  commands: [
    {
      name: 'cost',
      description: '查看 Bot 花費面板',
      handler: costCommand,
    },
    {
      name: 'usage',
      description: '查看 Anthropic API 本月用量',
      handler: usageCommand,
    },
  ],
}

export default costPlugin
