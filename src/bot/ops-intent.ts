import type { BotContext } from '../types/context.js'
import {
  listProjects,
  getProject,
  getLogs,
  getTelemetry,
  type CloudPipeProject,
  type CloudPipeDeployment,
} from './cloudpipe-client.js'

/**
 * Ops-intent router — answers CloudPipe operational questions directly, without
 * spinning up a Claude turn:
 *   - status:  "makee 好了沒"  "survey 狀態"  "X deployed?"
 *   - all:     "全部還好嗎"  "dashboard"  "整體狀態"
 *   - logs:    "看 makee 的 log"  "survey logs"
 *   - restart: "重啟 makee"   (→ confirm button)
 *   - rollback:"回滾 survey"   (→ confirm button)
 *
 * Conservative: status/logs only fire when a token resolves to a real CloudPipe
 * project; otherwise we return null and the message flows to Claude as normal.
 */

export type OpsIntent =
  | { kind: 'status'; query: string }
  | { kind: 'status-all' }
  | { kind: 'logs'; query: string }
  | { kind: 'restart'; query: string }
  | { kind: 'rollback'; query: string }

const STATUS_RE = /(好了沒|好了嗎|上線了嗎|上線了沒|部署好了|部署完了|部署完成了嗎|狀態如何|狀態怎樣|狀態|怎樣了|怎麼樣了|活著嗎|還活著|跑起來了嗎|ok了嗎|deployed|status)/i
const ALL_RE = /(全部|所有|大家|整體|總覽|健康狀態|都還好|還好嗎|dashboard|overview|all good)/i
const LOG_RE = /(\blogs?\b|日誌|錯誤訊息|報錯|印.*log|看.*log|的\s*log)/i
const RESTART_RE = /^\s*(重新啟動|重啟|重開|restart)\s+(.+)$/i
const ROLLBACK_RE = /^\s*(回滾|退回上一版|還原版本|rollback)\s+(.+)$/i

// Words to strip when extracting a project name from a status/log query.
const NOISE = new Set([
  'the', 'a', 'is', 'are', 'of', '的', '專案', '服務', '網站', '站',
  '好了', '沒', '嗎', '了', '狀態', '怎樣', '怎麼樣', '看', '一下', '請', '幫我',
  '查', '查看', '顯示', '印', 'log', 'logs', '日誌', 'status', 'deployed', '部署',
  '現在', '目前', '可以', '嗎?', '?', '？',
])

function extractQuery(text: string, verbRe?: RegExp): string {
  let t = text.trim()
  if (verbRe) {
    const m = verbRe.exec(t)
    if (m) t = (m[2] ?? '').trim()
  }
  // Strip the status/log marker phrases, then keep meaningful tokens.
  const tokens = t
    .replace(STATUS_RE, ' ')
    .replace(LOG_RE, ' ')
    .replace(/[?？!！。,，]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !NOISE.has(w.toLowerCase()))
  return tokens.join(' ').trim()
}

/** Detect an ops intent. Returns null when the message is not an ops command. */
export function detectOpsIntent(text: string): OpsIntent | null {
  const t = text.trim()
  if (!t || t.length > 80) return null

  // Imperative restart / rollback (anchored at start).
  const restartM = RESTART_RE.exec(t)
  if (restartM) return { kind: 'restart', query: restartM[2].trim() }

  const rollbackM = ROLLBACK_RE.exec(t)
  if (rollbackM) return { kind: 'rollback', query: rollbackM[2].trim() }

  // Logs.
  if (LOG_RE.test(t)) {
    const query = extractQuery(t)
    if (query) return { kind: 'logs', query }
    return null
  }

  // Status — single project or whole-ecosystem dashboard.
  if (STATUS_RE.test(t)) {
    const query = extractQuery(t)
    if (query) return { kind: 'status', query }
    if (ALL_RE.test(t)) return { kind: 'status-all' }
    return null
  }

  // Bare "全部還好嗎" / "dashboard" with no status verb.
  if (ALL_RE.test(t) && t.length <= 20) return { kind: 'status-all' }

  return null
}

// ---- resolution + formatting ----

function resolveProject(
  query: string,
  projects: readonly CloudPipeProject[]
): CloudPipeProject | null {
  const q = query.toLowerCase().trim()
  if (!q) return null
  return (
    projects.find((p) => p.id.toLowerCase() === q) ||
    projects.find((p) => p.id.toLowerCase().startsWith(q)) ||
    projects.find((p) => p.id.toLowerCase().includes(q)) ||
    null
  )
}

function ago(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '從未'
  const ts = typeof value === 'number' ? value : Date.parse(String(value))
  if (Number.isNaN(ts)) return String(value)
  const diffMs = Date.now() - ts
  const min = Math.round(diffMs / 60000)
  if (min < 1) return '剛剛'
  if (min < 60) return `${min} 分鐘前`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小時前`
  return `${Math.round(hr / 24)} 天前`
}

function statusEmoji(status?: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'deployed':
    case 'success':
      return '✅'
    case 'building':
      return '⏳'
    case 'failed':
    case 'error':
      return '❌'
    case 'rolled_back':
      return '↩️'
    case 'skipped':
    case 'aborted':
      return '⚠️'
    default:
      return '•'
  }
}

function short(commit?: string | null): string {
  return commit ? String(commit).slice(0, 7) : '—'
}

function formatProjectStatus(
  project: CloudPipeProject,
  deployments: readonly CloudPipeDeployment[]
): string {
  const last = deployments[0]
  const status = last?.status ?? project.lastDeployStatus
  const commit = last?.commit ?? project.lastDeployCommit ?? project.runningCommit
  const when = last?.finishedAt ?? project.lastDeployAt
  const lines = [
    `${statusEmoji(status)} *${project.id}* — ${status ?? '未知'}`,
    `commit \`${short(commit)}\` · ${ago(when)}`,
  ]
  if (project.runningCommit && project.runningCommit !== commit) {
    lines.push(`執行中 \`${short(project.runningCommit)}\``)
  }
  if (project.failedCommits && project.failedCommits.length > 0) {
    lines.push(`⛔ 失敗清單 ${project.failedCommits.length} 筆(\`/deploy --force\` 可略過)`)
  }
  if (project.suspended) lines.push('💤 已休眠(scale-to-zero)')
  if (project.disabled) lines.push('🚫 已停用')
  if (last?.error) lines.push(`原因:${String(last.error).slice(0, 180)}`)
  return lines.join('\n')
}

// ---- execution ----

export async function runOpsIntent(ctx: BotContext, intent: OpsIntent): Promise<boolean> {
  if (intent.kind === 'status-all') return runStatusAll(ctx)

  const list = await listProjects()
  if (list.notReady) return false // CloudPipe unreachable → let Claude try
  if (!list.ok || !list.data) {
    await ctx.reply(`⚠️ 查 CloudPipe 失敗:${list.error ?? '未知錯誤'}`)
    return true
  }
  const project = resolveProject(intent.query, list.data.projects)
  if (!project) return false // unknown name → not an ops command, fall to Claude

  switch (intent.kind) {
    case 'status':
      return runStatus(ctx, project)
    case 'logs':
      return runLogs(ctx, project)
    case 'restart':
      return askConfirm(ctx, 'restart', project.id, `🔄 確定要重啟 *${project.id}*?`)
    case 'rollback':
      return askConfirm(ctx, 'rollback', project.id, `⚠️ 確定要把 *${project.id}* 回滾到上一版?`)
  }
}

async function runStatus(ctx: BotContext, project: CloudPipeProject): Promise<boolean> {
  const detail = await getProject(project.id)
  const deployments = detail.ok && detail.data ? detail.data.deployments : []
  const merged = detail.ok && detail.data ? detail.data.project : project
  await ctx.reply(formatProjectStatus(merged, deployments ?? []), { parse_mode: 'Markdown' })
  return true
}

async function runLogs(ctx: BotContext, project: CloudPipeProject): Promise<boolean> {
  const pm2Name = project.pm2Name || project.id
  const res = await getLogs(pm2Name)
  if (!res.ok || !res.data) {
    await ctx.reply(`⚠️ 取 ${project.id} 的 log 失敗:${res.error ?? '未知錯誤'}`)
    return true
  }
  // Telegram caps at 4096 chars — keep the tail, where errors usually are.
  const raw = res.data.logs || '(無 log)'
  const tail = raw.length > 3500 ? '…(前略)\n' + raw.slice(-3500) : raw
  await ctx.reply(`📋 *${project.id}* log:\n\`\`\`\n${tail}\n\`\`\``, { parse_mode: 'Markdown' })
  return true
}

async function runStatusAll(ctx: BotContext): Promise<boolean> {
  const list = await listProjects()
  if (list.notReady) return false
  if (!list.ok || !list.data) {
    await ctx.reply(`⚠️ 查 CloudPipe 失敗:${list.error ?? '未知錯誤'}`)
    return true
  }
  const projects = list.data.projects
  const bad = projects.filter(
    (p) =>
      !p.disabled &&
      ((p.lastDeployStatus && /fail|error|abort/i.test(p.lastDeployStatus)) ||
        (p.failedCommits && p.failedCommits.length > 0))
  )
  const tele = await getTelemetry()
  const alerts =
    tele.ok && tele.data && Array.isArray((tele.data as { alerts?: unknown[] }).alerts)
      ? ((tele.data as { alerts: unknown[] }).alerts as unknown[])
      : []

  const lines = [
    `📊 *CloudPipe 總覽* — ${projects.length} 個專案`,
    bad.length === 0
      ? '✅ 全部健康,沒有失敗或卡住的部署'
      : `⚠️ ${bad.length} 個需要注意:`,
    ...bad.slice(0, 12).map((p) => {
      const flags: string[] = []
      if (p.lastDeployStatus && /fail|error|abort/i.test(p.lastDeployStatus)) {
        flags.push(p.lastDeployStatus)
      }
      if (p.failedCommits && p.failedCommits.length > 0) {
        flags.push(`失敗清單 ${p.failedCommits.length}`)
      }
      return `  ${statusEmoji(p.lastDeployStatus)} ${p.id} — ${flags.join(' · ')}`
    }),
  ]
  if (alerts.length > 0) lines.push(`🔔 自動化警示 ${alerts.length} 則`)
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
  return true
}

function askConfirm(
  ctx: BotContext,
  action: 'restart' | 'rollback',
  projectId: string,
  prompt: string
): Promise<boolean> {
  return ctx
    .reply(prompt, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: action === 'restart' ? '✅ 重啟' : '✅ 回滾', callback_data: `cp_${action}:${projectId}` },
            { text: '❌ 取消', callback_data: 'cp_cancel' },
          ],
        ],
      },
    })
    .then(() => true)
}
