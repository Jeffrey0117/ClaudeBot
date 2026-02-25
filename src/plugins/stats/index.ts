import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { readActivities, todayStart, daysAgo } from './activity-logger.js'
import { scanGitActivity, type GitSummary } from './git-scanner.js'

// --- Formatting helpers ---

function bar(value: number, max: number, width = 10): string {
  if (max === 0) return '░'.repeat(width)
  const filled = Math.round((value / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  const hours = Math.floor(mins / 60)
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

function heatSquare(count: number): string {
  if (count === 0) return '⬜'
  if (count <= 3) return '🟨'
  if (count <= 8) return '🟧'
  return '🟩'
}

// --- Subcommand handlers ---

function formatToday(): string {
  const now = Date.now()
  const start = todayStart()
  const activities = readActivities(start, now)
  const todayISO = new Date().toISOString().slice(0, 10)

  // Git stats for today
  const git = scanGitActivity(todayISO)

  const prompts = activities.filter((a) => a.type === 'prompt_complete')
  const messages = activities.filter((a) => a.type === 'message_sent').length
  const voices = activities.filter((a) => a.type === 'voice_sent').length
  const totalCost = prompts.reduce((s, a) => s + (a.costUsd ?? 0), 0)
  const totalDuration = prompts.reduce((s, a) => s + (a.durationMs ?? 0), 0)
  const totalTools = prompts.reduce((s, a) => s + (a.toolCount ?? 0), 0)

  // Project breakdown from activities
  const projectMap = new Map<string, number>()
  for (const a of activities) {
    projectMap.set(a.project, (projectMap.get(a.project) ?? 0) + 1)
  }
  const topProjects = [...projectMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `  ${name}: ${count} 次互動`)
    .join('\n')

  return [
    `📊 *今日統計* (${todayISO})`,
    '',
    `🔨 Commits: *${git.totalCommits}*`,
    `📝 Lines: *+${git.totalInsertions}* / *-${git.totalDeletions}*`,
    `💬 訊息: *${messages}* | 🎤 語音: *${voices}*`,
    `🤖 Prompts: *${prompts.length}*`,
    `🔧 Tools used: *${totalTools}*`,
    `⏱️ AI 時間: *${formatDuration(totalDuration)}*`,
    `💰 花費: *$${totalCost.toFixed(2)}*`,
    '',
    topProjects ? `*活躍專案:*\n${topProjects}` : '',
  ].filter(Boolean).join('\n')
}

function formatWeek(): string {
  const now = Date.now()
  const weekAgo = daysAgo(7)
  const activities = readActivities(weekAgo, now)
  const weekAgoISO = new Date(weekAgo).toISOString().slice(0, 10)
  const git = scanGitActivity(weekAgoISO)

  const prompts = activities.filter((a) => a.type === 'prompt_complete')
  const messages = activities.filter((a) => a.type === 'message_sent').length
  const voices = activities.filter((a) => a.type === 'voice_sent').length
  const totalCost = prompts.reduce((s, a) => s + (a.costUsd ?? 0), 0)

  // Daily bar chart
  const days = ['日', '一', '二', '三', '四', '五', '六']
  const dailyCommitMap = new Map(git.dailyCommits.map((d) => [d.date, d.count]))
  const maxDaily = Math.max(...git.dailyCommits.map((d) => d.count), 1)

  const barLines: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(daysAgo(i))
    const dateStr = d.toISOString().slice(0, 10)
    const dayName = days[d.getDay()]
    const count = dailyCommitMap.get(dateStr) ?? 0
    barLines.push(`${dayName} ${bar(count, maxDaily, 12)} ${count}`)
  }

  return [
    `📊 *本週統計*`,
    '',
    `🔨 Commits: *${git.totalCommits}*`,
    `📝 Lines: *+${git.totalInsertions}* / *-${git.totalDeletions}*`,
    `💬 訊息: *${messages}* | 🎤 語音: *${voices}*`,
    `🤖 Prompts: *${prompts.length}*`,
    `💰 花費: *$${totalCost.toFixed(2)}*`,
    '',
    '*每日 commits:*',
    '```',
    ...barLines,
    '```',
    '',
    git.projects.length > 0
      ? '*專案排行:*\n' + git.projects.slice(0, 5)
          .map((p, i) => `  ${i + 1}. ${p.name} (${p.commits} commits, +${p.insertions}/-${p.deletions})`)
          .join('\n')
      : '',
  ].filter(Boolean).join('\n')
}

function formatMonth(): string {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthISO = monthStart.toISOString().slice(0, 10)
  const activities = readActivities(monthStart.getTime(), Date.now())
  const git = scanGitActivity(monthISO)

  const prompts = activities.filter((a) => a.type === 'prompt_complete')
  const messages = activities.filter((a) => a.type === 'message_sent').length
  const voices = activities.filter((a) => a.type === 'voice_sent').length
  const totalCost = prompts.reduce((s, a) => s + (a.costUsd ?? 0), 0)

  // Build heatmap grid
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dailyMap = new Map(git.dailyCommits.map((d) => [d.date, d.count]))

  const weeks: string[] = []
  let weekLine = ''
  const firstDow = new Date(now.getFullYear(), now.getMonth(), 1).getDay()

  // Pad first week
  weekLine = '  '.repeat(firstDow)
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(now.getFullYear(), now.getMonth(), day)
    const dateStr = d.toISOString().slice(0, 10)
    const count = dailyMap.get(dateStr) ?? 0
    weekLine += heatSquare(count)
    if (d.getDay() === 6 || day === daysInMonth) {
      weeks.push(weekLine)
      weekLine = ''
    }
  }

  const monthName = now.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' })

  return [
    `📊 *${monthName}*`,
    '',
    `🔨 Commits: *${git.totalCommits}*`,
    `📝 Lines: *+${git.totalInsertions}* / *-${git.totalDeletions}*`,
    `💬 訊息: *${messages}* | 🎤 語音: *${voices}*`,
    `🤖 Prompts: *${prompts.length}*`,
    `💰 花費: *$${totalCost.toFixed(2)}*`,
    '',
    '*日 一 二 三 四 五 六*',
    ...weeks,
    '',
    `🟩 9+ 🟧 4-8 🟨 1-3 ⬜ 休息`,
  ].join('\n')
}

function formatHours(): string {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthISO = monthStart.toISOString().slice(0, 10)

  const git = scanGitActivity(monthISO)
  const activities = readActivities(monthStart.getTime(), Date.now())

  // Combine git + prompt activity per hour
  const hourCounts = new Array(24).fill(0) as number[]
  for (let h = 0; h < 24; h++) {
    hourCounts[h] = git.hourDistribution[h]
  }
  for (const a of activities) {
    const hour = new Date(a.timestamp).getHours()
    hourCounts[hour]++
  }

  const maxHour = Math.max(...hourCounts, 1)

  const lines: string[] = []
  for (let h = 0; h < 24; h++) {
    const label = String(h).padStart(2, '0')
    const count = hourCounts[h]
    lines.push(`${label}:00 ${bar(count, maxHour, 15)} ${count}`)
  }

  // Find peak hours
  const sorted = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)

  const peak = sorted.slice(0, 3).map((h) => `${h.hour}:00`).join(', ')
  const lazy = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.hour >= 9 && h.hour <= 23 && h.count === 0)
    .map((h) => `${h.hour}:00`)

  return [
    `⏰ *24 小時活躍分布* (本月)`,
    '',
    '```',
    ...lines,
    '```',
    '',
    peak ? `🔥 尖峰時段: *${peak}*` : '',
    lazy.length > 0 ? `😴 休息時段: ${lazy.slice(0, 5).join(', ')}` : '💪 全天都有活動！',
  ].filter(Boolean).join('\n')
}

function formatProjects(): string {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthISO = monthStart.toISOString().slice(0, 10)

  const git = scanGitActivity(monthISO)

  if (git.projects.length === 0) {
    return '📊 本月尚無 commit 紀錄'
  }

  const maxCommits = Math.max(...git.projects.map((p) => p.commits), 1)

  const lines = git.projects.slice(0, 15).map((p, i) => {
    const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`
    return `${rank} *${p.name}*\n   ${bar(p.commits, maxCommits, 12)} ${p.commits} commits (+${p.insertions}/-${p.deletions})`
  })

  return [
    `📊 *專案排行* (本月)`,
    '',
    ...lines,
  ].join('\n')
}

// --- Main command handler ---

async function statsCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const sub = raw.replace(/^\/stats(@\S+)?\s*/, '').trim().toLowerCase()

  try {
    let result: string

    switch (sub) {
      case 'week':
      case 'w':
        result = formatWeek()
        break
      case 'month':
      case 'm':
        result = formatMonth()
        break
      case 'hours':
      case 'h':
        result = formatHours()
        break
      case 'project':
      case 'projects':
      case 'p':
        result = formatProjects()
        break
      default:
        result = formatToday()
        break
    }

    await ctx.reply(result, { parse_mode: 'Markdown' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ Stats 載入失敗: ${msg}`)
  }
}

const statsPlugin: Plugin = {
  name: 'stats',
  description: '開發生產力統計',
  commands: [
    {
      name: 'stats',
      description: '查看生產力統計 (week/month/hours/projects)',
      handler: statsCommand,
    },
  ],
}

export default statsPlugin
