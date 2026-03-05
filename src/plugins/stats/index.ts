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

/** Format a comparison delta like " (+12%)" or " (-5%)" */
function delta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? ' 🆕' : ''
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct === 0) return ''
  return pct > 0 ? ` (📈+${pct}%)` : ` (📉${pct}%)`
}

/** Parse relative time like "3d", "2w", "1m" or absolute "2025-01", "2025-02-15" */
function parseTimeRange(input: string): { start: number; end: number; label: string } | null {
  const now = Date.now()

  // Relative: Nd, Nw, Nm
  const relMatch = input.match(/^(\d+)\s*(d|w|m)$/i)
  if (relMatch) {
    const n = parseInt(relMatch[1], 10)
    const unit = relMatch[2].toLowerCase()
    if (unit === 'd') {
      return { start: daysAgo(n), end: now, label: `近 ${n} 天` }
    }
    if (unit === 'w') {
      return { start: daysAgo(n * 7), end: now, label: `近 ${n} 週` }
    }
    if (unit === 'm') {
      const d = new Date()
      d.setMonth(d.getMonth() - n)
      d.setHours(0, 0, 0, 0)
      return { start: d.getTime(), end: now, label: `近 ${n} 個月` }
    }
  }

  // Absolute month: YYYY-MM
  const monthMatch = input.match(/^(\d{4})-(\d{2})$/)
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10)
    const month = parseInt(monthMatch[2], 10) - 1
    const start = new Date(year, month, 1).getTime()
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime()
    const label = new Date(year, month).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' })
    return { start, end: Math.min(end, now), label }
  }

  // Absolute date: YYYY-MM-DD
  const dateMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateMatch) {
    const start = new Date(
      parseInt(dateMatch[1], 10),
      parseInt(dateMatch[2], 10) - 1,
      parseInt(dateMatch[3], 10),
    ).getTime()
    const end = start + 86_400_000 - 1
    return { start, end: Math.min(end, now), label: input }
  }

  return null
}

/** Aggregate stats from activities + git for a time range */
function aggregateStats(start: number, end: number) {
  const sinceISO = new Date(start).toISOString().slice(0, 10)
  const untilISO = new Date(end).toISOString().slice(0, 10)
  const activities = readActivities(start, end)
  const git = scanGitActivity(sinceISO, untilISO)

  const prompts = activities.filter((a) => a.type === 'prompt_complete')
  const messages = activities.filter((a) => a.type === 'message_sent').length
  const voices = activities.filter((a) => a.type === 'voice_sent').length
  const totalCost = prompts.reduce((s, a) => s + (a.costUsd ?? 0), 0)
  const totalDuration = prompts.reduce((s, a) => s + (a.durationMs ?? 0), 0)
  const totalTools = prompts.reduce((s, a) => s + (a.toolCount ?? 0), 0)

  return {
    git,
    activities,
    prompts: prompts.length,
    messages,
    voices,
    totalCost,
    totalDuration,
    totalTools,
  }
}

/** Calculate current streak (consecutive active days with commits) */
function calcStreak(git: GitSummary): number {
  const activeDays = new Set(git.dailyCommits.map((d) => d.date))
  const d = new Date()
  let streak = 0

  // If today has no commits yet, start from yesterday
  const todayStr = d.toISOString().slice(0, 10)
  if (!activeDays.has(todayStr)) {
    d.setDate(d.getDate() - 1)
  }

  while (true) {
    const dateStr = d.toISOString().slice(0, 10)
    if (activeDays.has(dateStr)) {
      streak++
      d.setDate(d.getDate() - 1)
    } else {
      break
    }
  }
  return streak
}

// --- Subcommand handlers ---

function formatToday(): string {
  const now = Date.now()
  const start = todayStart()
  const s = aggregateStats(start, now)

  // Project breakdown from activities
  const projectMap = new Map<string, number>()
  for (const a of s.activities) {
    projectMap.set(a.project, (projectMap.get(a.project) ?? 0) + 1)
  }
  const topProjects = [...projectMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `  ${name}: ${count} 次互動`)
    .join('\n')

  // Compare with yesterday
  const yesterdayStart = daysAgo(1)
  const prev = aggregateStats(yesterdayStart, start - 1)

  const todayISO = new Date().toISOString().slice(0, 10)

  return [
    `📊 *今日統計* (${todayISO})`,
    '',
    `🔨 Commits: *${s.git.totalCommits}*${delta(s.git.totalCommits, prev.git.totalCommits)}`,
    `📝 Lines: *+${s.git.totalInsertions}* / *-${s.git.totalDeletions}*`,
    `💬 訊息: *${s.messages}* | 🎤 語音: *${s.voices}*`,
    `🤖 Prompts: *${s.prompts}*${delta(s.prompts, prev.prompts)}`,
    `🔧 Tools used: *${s.totalTools}*`,
    `⏱️ AI 時間: *${formatDuration(s.totalDuration)}*`,
    `💰 花費: *$${s.totalCost.toFixed(2)}*${delta(s.totalCost, prev.totalCost)}`,
    '',
    topProjects ? `*活躍專案:*\n${topProjects}` : '',
  ].filter(Boolean).join('\n')
}

function formatWeek(): string {
  const now = Date.now()
  const weekAgo = daysAgo(7)
  const s = aggregateStats(weekAgo, now)

  // Compare with previous week
  const prevWeekStart = daysAgo(14)
  const prev = aggregateStats(prevWeekStart, weekAgo - 1)

  // Daily bar chart
  const days = ['日', '一', '二', '三', '四', '五', '六']
  const dailyCommitMap = new Map(s.git.dailyCommits.map((d) => [d.date, d.count]))
  const maxDaily = Math.max(...s.git.dailyCommits.map((d) => d.count), 1)

  const barLines: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(daysAgo(i))
    const dateStr = d.toISOString().slice(0, 10)
    const dayName = days[d.getDay()]
    const count = dailyCommitMap.get(dateStr) ?? 0
    barLines.push(`${dayName} ${bar(count, maxDaily, 12)} ${count}`)
  }

  // Streak (reuse the week's git data — streak only needs recent daily commits)
  const streak = calcStreak(s.git)

  return [
    '📊 *本週統計*',
    '',
    `🔨 Commits: *${s.git.totalCommits}*${delta(s.git.totalCommits, prev.git.totalCommits)}`,
    `📝 Lines: *+${s.git.totalInsertions}* / *-${s.git.totalDeletions}*`,
    `💬 訊息: *${s.messages}* | 🎤 語音: *${s.voices}*`,
    `🤖 Prompts: *${s.prompts}*${delta(s.prompts, prev.prompts)}`,
    `💰 花費: *$${s.totalCost.toFixed(2)}*${delta(s.totalCost, prev.totalCost)}`,
    streak > 1 ? `🔥 連續活躍: *${streak} 天*` : '',
    '',
    '*每日 commits:*',
    '```',
    ...barLines,
    '```',
    '',
    s.git.projects.length > 0
      ? '*專案排行:*\n' + s.git.projects.slice(0, 5)
          .map((p, i) => `  ${i + 1}. ${p.name} (${p.commits} commits, +${p.insertions}/-${p.deletions})`)
          .join('\n')
      : '',
  ].filter(Boolean).join('\n')
}

function formatMonth(): string {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const s = aggregateStats(monthStart.getTime(), Date.now())

  // Compare with previous month
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
  const prev = aggregateStats(prevMonthStart.getTime(), prevMonthEnd.getTime())

  // Build heatmap grid
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dailyMap = new Map(s.git.dailyCommits.map((d) => [d.date, d.count]))

  const weeks: string[] = []
  let weekLine = ''
  const firstDow = new Date(now.getFullYear(), now.getMonth(), 1).getDay()

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

  // Active days count
  const activeDays = s.git.dailyCommits.filter((d) => d.count > 0).length
  const monthName = now.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' })

  return [
    `📊 *${monthName}*`,
    '',
    `🔨 Commits: *${s.git.totalCommits}*${delta(s.git.totalCommits, prev.git.totalCommits)}`,
    `📝 Lines: *+${s.git.totalInsertions}* / *-${s.git.totalDeletions}*`,
    `💬 訊息: *${s.messages}* | 🎤 語音: *${s.voices}*`,
    `🤖 Prompts: *${s.prompts}*${delta(s.prompts, prev.prompts)}`,
    `💰 花費: *$${s.totalCost.toFixed(2)}*${delta(s.totalCost, prev.totalCost)}`,
    `📅 活躍天數: *${activeDays}* / ${daysInMonth}`,
    '',
    '*日 一 二 三 四 五 六*',
    ...weeks,
    '',
    '🟩 9+ 🟧 4-8 🟨 1-3 ⬜ 休息',
  ].join('\n')
}

function formatYear(): string {
  const now = new Date()
  const yearStart = new Date(now.getFullYear(), 0, 1)
  const yearISO = yearStart.toISOString().slice(0, 10)
  const git = scanGitActivity(yearISO)
  const activities = readActivities(yearStart.getTime(), Date.now())

  const prompts = activities.filter((a) => a.type === 'prompt_complete')
  const totalCost = prompts.reduce((s, a) => s + (a.costUsd ?? 0), 0)

  // Monthly summary bars
  const monthlyCommits = new Array(12).fill(0) as number[]
  for (const c of git.dailyCommits) {
    const m = parseInt(c.date.slice(5, 7), 10) - 1
    monthlyCommits[m] += c.count
  }
  const maxMonthly = Math.max(...monthlyCommits, 1)
  const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
  const currentMonth = now.getMonth()

  const barLines = months
    .slice(0, currentMonth + 1)
    .map((m, i) => {
      const count = monthlyCommits[i]
      return `${m}月 ${bar(count, maxMonthly, 12)} ${count}`
    })

  // Streak
  const streak = calcStreak(git)

  // Active days
  const activeDays = git.dailyCommits.filter((d) => d.count > 0).length
  const totalDays = Math.ceil((Date.now() - yearStart.getTime()) / 86_400_000)

  return [
    `📊 *${now.getFullYear()} 年度統計*`,
    '',
    `🔨 Commits: *${git.totalCommits}*`,
    `📝 Lines: *+${git.totalInsertions}* / *-${git.totalDeletions}*`,
    `🤖 Prompts: *${prompts.length}*`,
    `💰 累計花費: *$${totalCost.toFixed(2)}*`,
    `📅 活躍天數: *${activeDays}* / ${totalDays} (${Math.round(activeDays / totalDays * 100)}%)`,
    streak > 1 ? `🔥 連續活躍: *${streak} 天*` : '',
    '',
    '*每月 commits:*',
    '```',
    ...barLines,
    '```',
    '',
    git.projects.length > 0
      ? '*專案排行 (Top 10):*\n' + git.projects.slice(0, 10)
          .map((p, i) => {
            const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`
            return `${rank} ${p.name} (${p.commits})`
          })
          .join('\n')
      : '',
  ].filter(Boolean).join('\n')
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
    '⏰ *24 小時活躍分布* (本月)',
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
    '📊 *專案排行* (本月)',
    '',
    ...lines,
  ].join('\n')
}

/** Format stats for a custom time range (e.g. "3d", "2w", "2025-01") */
function formatRange(start: number, end: number, label: string): string {
  const s = aggregateStats(start, end)

  // Calculate range duration for comparison with equal-length previous period
  const durationMs = end - start
  const prevStart = start - durationMs
  const prevEnd = start - 1
  const prev = aggregateStats(prevStart, prevEnd)

  const activeDays = s.git.dailyCommits.filter((d) => d.count > 0).length
  const totalDays = Math.max(1, Math.ceil(durationMs / 86_400_000))

  // Daily bar chart (up to 14 days shown individually, else monthly)
  let chartSection = ''
  if (totalDays <= 14) {
    const dailyMap = new Map(s.git.dailyCommits.map((d) => [d.date, d.count]))
    const maxDaily = Math.max(...s.git.dailyCommits.map((d) => d.count), 1)
    const days = ['日', '一', '二', '三', '四', '五', '六']
    const barLines: string[] = []
    const cursor = new Date(start)
    while (cursor.getTime() <= end) {
      const dateStr = cursor.toISOString().slice(0, 10)
      const dayName = days[cursor.getDay()]
      const count = dailyMap.get(dateStr) ?? 0
      barLines.push(`${dayName} ${dateStr.slice(5)} ${bar(count, maxDaily, 10)} ${count}`)
      cursor.setDate(cursor.getDate() + 1)
    }
    chartSection = ['', '*每日活動:*', '```', ...barLines, '```'].join('\n')
  }

  return [
    `📊 *${label}*`,
    '',
    `🔨 Commits: *${s.git.totalCommits}*${delta(s.git.totalCommits, prev.git.totalCommits)}`,
    `📝 Lines: *+${s.git.totalInsertions}* / *-${s.git.totalDeletions}*`,
    `💬 訊息: *${s.messages}* | 🎤 語音: *${s.voices}*`,
    `🤖 Prompts: *${s.prompts}*${delta(s.prompts, prev.prompts)}`,
    `💰 花費: *$${s.totalCost.toFixed(2)}*${delta(s.totalCost, prev.totalCost)}`,
    `📅 活躍天數: *${activeDays}* / ${totalDays}`,
    chartSection,
    '',
    s.git.projects.length > 0
      ? '*專案排行:*\n' + s.git.projects.slice(0, 5)
          .map((p, i) => `  ${i + 1}. ${p.name} (${p.commits} commits)`)
          .join('\n')
      : '',
  ].filter(Boolean).join('\n')
}

// --- Main command handler ---

async function statsCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const sub = raw.replace(/^\/stats(@\S+)?\s*/, '').trim().toLowerCase()

  // Show loading indicator — git scanning can be slow with many projects
  const loadingMsg = await ctx.reply('📊 正在統計中...').catch(() => null)

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
      case 'year':
      case 'y':
        result = formatYear()
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
      case '':
      case 'today':
        result = formatToday()
        break
      default: {
        // Try custom time range
        const range = parseTimeRange(sub)
        if (range) {
          result = formatRange(range.start, range.end, range.label)
        } else {
          result = [
            '📊 */stats* 用法:',
            '',
            '`/stats` — 今日',
            '`/stats week` — 本週',
            '`/stats month` — 本月',
            '`/stats year` — 年度',
            '`/stats hours` — 24h 分布',
            '`/stats projects` — 專案排行',
            '',
            '*自訂區間:*',
            '`/stats 3d` — 近 3 天',
            '`/stats 2w` — 近 2 週',
            '`/stats 6m` — 近 6 個月',
            '`/stats 2025-02` — 指定月份',
            '`/stats 2025-02-15` — 指定日期',
          ].join('\n')
        }
        break
      }
    }

    // Delete loading message, then send result
    if (loadingMsg) {
      ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {})
    }
    await ctx.reply(result, { parse_mode: 'Markdown' })
  } catch (error) {
    if (loadingMsg) {
      ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {})
    }
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
      description: '查看生產力統計 (week/month/year/hours/projects/3d/2w)',
      handler: statsCommand,
    },
  ],
}

export default statsPlugin
