/**
 * @pipe directive executor.
 *
 * Connects ClaudeBot to CloudPipe's HTTP API, making ClaudeBot the
 * "brain" that can control all CloudPipe services via natural language.
 *
 * Format:  @pipe(service.action)  or  @pipe(service.action, param)
 * Examples:
 *   @pipe(monitor.status)          — get all monitored targets
 *   @pipe(monitor.check)           — trigger immediate health check
 *   @pipe(monitor.add, https://x)  — add a URL to monitoring
 *   @pipe(monitor.remove, https://x)
 *   @pipe(gateway.tools)           — list all gateway tools
 *   @pipe(gateway.call, toolName)  — call a gateway tool
 *   @pipe(health)                  — CloudPipe health check
 *
 * All @pipe calls are stripped from the displayed text, and results
 * are sent as separate Telegram messages.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import { splitText } from './text-splitter.js'

// --- Types ---

export interface PipeDirective {
  readonly type: 'pipe'
  readonly service: string
  readonly action: string
  readonly param: string
  readonly raw: string
}

export interface PipeConfig {
  readonly baseUrl: string
  readonly serviceToken: string
}

// --- Pattern ---

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const PIPE_PATTERN = /^[ \t]*`?@pipe[（(]([^)）]+)[)）]`?\s*$/gm

// --- Parser ---

export function parsePipeDirectives(text: string): readonly PipeDirective[] {
  const clean = text.replace(CODE_BLOCK_RE, '')
  const results: PipeDirective[] = []

  PIPE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PIPE_PATTERN.exec(clean)) !== null) {
    const inner = match[1].trim()
    if (!inner) continue

    // Split on first comma: "monitor.status, https://..." → service.action + param
    const commaIdx = inner.indexOf(',')
    const serviceAction = commaIdx === -1 ? inner : inner.slice(0, commaIdx).trim()
    const param = commaIdx === -1 ? '' : inner.slice(commaIdx + 1).trim()

    // Split service.action
    const dotIdx = serviceAction.indexOf('.')
    const service = dotIdx === -1 ? serviceAction : serviceAction.slice(0, dotIdx)
    const action = dotIdx === -1 ? '' : serviceAction.slice(dotIdx + 1)

    results.push({ type: 'pipe', service, action, param, raw: match[0] })
  }

  return results
}

export function stripPipeDirectives(text: string): string {
  return text
    .replace(PIPE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- Config loader ---

export function loadPipeConfig(): PipeConfig | null {
  // CLOUDPIPE_URL env var takes priority (e.g. "http://192.168.1.10:8787")
  if (process.env.CLOUDPIPE_URL) {
    return {
      baseUrl: process.env.CLOUDPIPE_URL.replace(/\/$/, ''),
      serviceToken: process.env.CLOUDPIPE_TOKEN || '',
    }
  }

  // Try reading CloudPipe config from known locations
  const possiblePaths = [
    join(process.cwd(), '..', 'CloudPipe', 'config.json'),
  ]

  for (const configPath of possiblePaths) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const config = JSON.parse(raw)
      const port = config.port || 8787
      return {
        baseUrl: `http://localhost:${port}`,
        serviceToken: config.serviceToken || '',
      }
    } catch {
      continue
    }
  }

  return null
}

// --- HTTP helper ---

export async function pipeRequest(
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) {
    headers['authorization'] = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }

    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, data: { error: msg } }
  }
}

// --- Service handlers ---

type ServiceHandler = (
  action: string,
  param: string,
  config: PipeConfig,
) => Promise<string>

const services: Record<string, ServiceHandler> = {
  async monitor(action, param, config) {
    const base = `${config.baseUrl}/monitor`

    switch (action) {
      case 'status':
      case '': {
        const result = await pipeRequest('GET', `${base}/status`)
        if (!result.ok) return `Monitor 連線失敗: ${JSON.stringify(result.data)}`
        return formatMonitorStatus(result.data as MonitorStatusResponse)
      }
      case 'check': {
        const result = await pipeRequest('POST', `${base}/check`)
        if (!result.ok) return `Monitor check 失敗: ${JSON.stringify(result.data)}`
        return '✅ 健康檢查已觸發'
      }
      case 'add': {
        if (!param) return '❌ 需要提供 URL，例如: @pipe(monitor.add, https://example.com)'
        const result = await pipeRequest('POST', `${base}/add`, { url: param })
        if (!result.ok) return `新增失敗: ${JSON.stringify(result.data)}`
        return `✅ 已新增監控: ${param}`
      }
      case 'remove': {
        if (!param) return '❌ 需要提供 URL'
        const result = await pipeRequest('POST', `${base}/remove`, { url: param })
        if (!result.ok) return `移除失敗: ${JSON.stringify(result.data)}`
        return `✅ 已移除監控: ${param}`
      }
      default:
        return `❌ 未知 monitor 操作: ${action}\n可用: status, check, add, remove`
    }
  },

  async gateway(action, param, config) {
    const base = `${config.baseUrl}/api/gateway`
    const token = config.serviceToken

    switch (action) {
      case 'tools':
      case '': {
        const result = await pipeRequest('GET', `${base}/tools`, undefined, token)
        if (!result.ok) return `Gateway 連線失敗: ${JSON.stringify(result.data)}`
        return formatGatewayTools(result.data as GatewayToolsResponse)
      }
      case 'call': {
        if (!param) return '❌ 需要提供 tool 名稱'
        // param may be "toolName, {args}" — split tool name from arguments
        const callComma = param.indexOf(',')
        const toolName = callComma === -1 ? param.trim() : param.slice(0, callComma).trim()
        const toolArgsRaw = callComma === -1 ? '' : param.slice(callComma + 1).trim()
        let toolArgs: Record<string, unknown> | undefined
        if (toolArgsRaw) {
          try { toolArgs = JSON.parse(toolArgsRaw) } catch { /* not JSON, ignore */ }
        }
        const body: Record<string, unknown> = { tool: toolName }
        if (toolArgs) body.args = toolArgs
        const result = await pipeRequest('POST', `${base}/call`, body, token)
        if (!result.ok) {
          const errData = result.data as { error?: string } | string
          const errMsg = typeof errData === 'string' ? errData : errData?.error ?? JSON.stringify(errData)
          if (result.status === 404 || /not found/i.test(errMsg)) {
            // Auto-fetch available tools so Claude can self-correct
            const toolsResult = await pipeRequest('GET', `${base}/tools`, undefined, token)
            let toolList = ''
            if (toolsResult.ok) {
              const toolsData = toolsResult.data as GatewayToolsResponse
              const names = toolsData.tools?.map((t) => t.name) ?? []
              toolList = names.length > 0
                ? `\n\n可用的 tools:\n${names.map((n) => `• ${n}`).join('\n')}`
                : ''
            }
            return `❌ Tool \`${toolName}\` 不存在${toolList}`
          }
          return `❌ Tool 呼叫失敗 (${result.status}): ${errMsg}`
        }
        const formatted = JSON.stringify(result.data, null, 2)
        return `🔧 ${toolName} 結果:\n${formatted}`
      }
      case 'pipelines': {
        const result = await pipeRequest('GET', `${base}/pipelines`, undefined, token)
        if (!result.ok) return `Pipeline 查詢失敗: ${JSON.stringify(result.data)}`
        return formatPipelines(result.data as PipelineListResponse)
      }
      case 'refresh': {
        const result = await pipeRequest('POST', `${base}/refresh`, undefined, token)
        if (!result.ok) return `Refresh 失敗: ${JSON.stringify(result.data)}`
        return '✅ Gateway tools 已重新載入'
      }
      default:
        return `❌ 未知 gateway 操作: ${action}\n可用: tools, call, pipelines, refresh`
    }
  },

  async health(_action, _param, config) {
    const result = await pipeRequest('GET', `${config.baseUrl}/health`)
    if (!result.ok) return '❌ CloudPipe 無法連線'
    const data = result.data as { status: string; routes: string[]; timestamp: string }
    return `✅ CloudPipe 運行中\n服務: ${data.routes?.join(', ') || 'N/A'}\n時間: ${data.timestamp || 'N/A'}`
  },

  async rawtxt(action, param, _config) {
    // Direct call to RawTxt service (bypasses gateway body-forwarding bug)
    const RAWTXT_BASE = 'http://localhost:4015'

    switch (action) {
      case 'create':
      case '': {
        if (!param) return '❌ 需要提供內容'
        const result = await pipeRequest('POST', `${RAWTXT_BASE}/api/paste`, { content: param })
        if (!result.ok) return `❌ RawTxt 建立失敗: ${JSON.stringify(result.data)}`
        const body = result.data as { data?: { id?: string; url?: string; rawUrl?: string } }
        const paste = body.data ?? {}
        return paste.url ?? paste.rawUrl ?? `已建立 paste: ${paste.id ?? ''}`
      }
      case 'read': {
        if (!param) return '❌ 需要提供 paste ID'
        const result = await pipeRequest('GET', `${RAWTXT_BASE}/${param}/raw`)
        if (!result.ok) return `❌ RawTxt 讀取失敗: ${JSON.stringify(result.data)}`
        return typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
      }
      case 'list': {
        const result = await pipeRequest('GET', `${RAWTXT_BASE}/api/pastes`)
        if (!result.ok) return `❌ RawTxt 查詢失敗: ${JSON.stringify(result.data)}`
        return JSON.stringify(result.data, null, 2)
      }
      default:
        return `❌ 未知 rawtxt 操作: ${action}\n可用: create, read, list`
    }
  },
}

// --- Response formatters ---

interface MonitorTarget {
  label: string
  status: string
  statusCode: number
  latencyMs: number
  consecutiveFailures: number
  lastCheckedAt: number
}

interface MonitorStatusResponse {
  targets: MonitorTarget[]
  checkedAt: number
}

function formatMonitorStatus(data: MonitorStatusResponse): string {
  if (!data.targets?.length) return '📊 目前沒有監控目標'

  const lines = ['📊 **Monitor 狀態**', '']
  for (const t of data.targets) {
    const icon = t.status === 'up' ? '🟢' : t.status === 'down' ? '🔴' : '⚪'
    const latency = t.latencyMs ? `${t.latencyMs}ms` : '-'
    lines.push(`${icon} **${t.label}** — HTTP ${t.statusCode || '-'} (${latency})`)
    if (t.consecutiveFailures > 0) {
      lines.push(`   ⚠️ 連續失敗: ${t.consecutiveFailures}`)
    }
  }
  return lines.join('\n')
}

interface GatewayTool {
  name: string
  project: string
  method: string
  path: string
  description: string
}

interface GatewayToolsResponse {
  tools: GatewayTool[]
  total: number
}

function formatGatewayTools(data: GatewayToolsResponse): string {
  if (!data.tools?.length) return '🔧 Gateway 沒有可用的 tools'

  const lines = [`🔧 **Gateway Tools** (${data.total})`, '']
  // Group by project
  const byProject = new Map<string, GatewayTool[]>()
  for (const t of data.tools) {
    const proj = t.project || 'unknown'
    if (!byProject.has(proj)) byProject.set(proj, [])
    byProject.get(proj)!.push(t)
  }

  for (const [proj, tools] of byProject) {
    lines.push(`**${proj}**`)
    for (const t of tools) {
      lines.push(`  • \`${t.name}\` — ${t.description || t.method + ' ' + t.path}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

interface PipelineListResponse {
  pipelines: Array<{ id: string; name: string; steps: number }>
}

function formatPipelines(data: PipelineListResponse): string {
  if (!data.pipelines?.length) return '🔗 沒有可用的 pipelines'

  const lines = ['🔗 **Pipelines**', '']
  for (const p of data.pipelines) {
    lines.push(`• **${p.name || p.id}** — ${p.steps} steps`)
  }
  return lines.join('\n')
}

// --- Direct service call (used by chain plugin) ---

export async function executePipeService(
  service: string,
  action: string,
  param: string,
): Promise<string> {
  const config = loadPipeConfig()
  if (!config) throw new Error('CloudPipe 未設定')

  const handler = services[service]
  if (!handler) {
    const available = Object.keys(services).join(', ')
    throw new Error(`未知服務: ${service}\n可用: ${available}`)
  }

  return handler(action, param, config)
}

// --- Send helper (Markdown → fallback plain text) ---

async function sendSafe(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' })
  } catch {
    await telegram.sendMessage(chatId, text)
  }
}

// --- Executor ---

export async function executePipeDirectives(
  directives: readonly PipeDirective[],
  chatId: number,
  telegram: Telegraf<BotContext>['telegram'],
): Promise<void> {
  const config = loadPipeConfig()

  for (const d of directives) {
    try {
      if (!config) {
        telegram.sendMessage(chatId, '⚠️ CloudPipe 未設定 — 找不到 config.json').catch(() => {})
        continue
      }

      const handler = services[d.service]
      if (!handler) {
        const available = Object.keys(services).join(', ')
        telegram.sendMessage(
          chatId,
          `⚠️ 未知服務: \`${d.service}\`\n可用: ${available}`,
          { parse_mode: 'Markdown' },
        ).catch(() => {})
        continue
      }

      const result = await handler(d.action, d.param, config)
      const chunks = splitText(result)
      for (const chunk of chunks) {
        await sendSafe(telegram, chatId, chunk)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pipe] @pipe(${d.service}.${d.action}) failed:`, msg)
      telegram.sendMessage(chatId, `⚠️ @pipe 失敗: ${msg}`).catch(() => {})
    }
  }
}
