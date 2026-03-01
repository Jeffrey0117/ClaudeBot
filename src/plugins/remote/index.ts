import { WebSocket } from 'ws'
import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { getPairing, getCodeForChat } from '../../remote/pairing-store.js'
import { getRelayPort } from '../../remote/relay-server.js'
import { env } from '../../config/env.js'
import type { ToolCallRequest, ToolCallResult, ToolCallError } from '../../remote/protocol.js'

// --- Relay client ---

const TOOL_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 5_000

interface RelayClient {
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<string>
  readonly close: () => void
}

function createRelayClient(port: number, code: string): Promise<RelayClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`)
    let requestId = 0
    const pending = new Map<number, {
      resolve: (r: string) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }>()

    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('連線逾時'))
    }, CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'proxy_connect', code }))
    })

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; error?: string; id?: number; result?: string }

      if (msg.type === 'proxy_connected') {
        clearTimeout(timer)
        resolve({
          call(tool: string, args: Record<string, unknown>): Promise<string> {
            return new Promise((res, rej) => {
              if (socket.readyState !== WebSocket.OPEN) {
                rej(new Error('連線已斷開'))
                return
              }
              const id = requestId++
              const t = setTimeout(() => {
                pending.delete(id)
                rej(new Error('操作逾時'))
              }, TOOL_TIMEOUT_MS)
              pending.set(id, { resolve: res, reject: rej, timer: t })
              const req: ToolCallRequest = { id, type: 'tool_call', tool, args }
              socket.send(JSON.stringify(req))
            })
          },
          close() { socket.close() },
        })
        return
      }

      if (msg.type === 'error') {
        clearTimeout(timer)
        socket.close()
        reject(new Error(msg.error ?? '連線錯誤'))
        return
      }

      if ((msg.type === 'tool_result' || msg.type === 'tool_error') && msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.type === 'tool_result') {
          p.resolve((msg as ToolCallResult).result)
        } else {
          p.reject(new Error((msg as ToolCallError).error))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket 錯誤: ${err.message}`))
    })

    socket.on('close', () => {
      pending.forEach((p) => {
        clearTimeout(p.timer)
        p.reject(new Error('連線已關閉'))
      })
      pending.clear()
    })
  })
}

async function withRelay(ctx: BotContext, fn: (client: RelayClient) => Promise<void>): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const pairing = getPairing(chatId, threadId)

  if (!pairing?.connected) {
    await ctx.reply('❌ 未配對遠端電腦，請先用 /pair 配對')
    return
  }

  const port = getRelayPort() || env.RELAY_PORT
  if (!port) {
    await ctx.reply('❌ Relay 未啟動')
    return
  }

  const code = getCodeForChat(chatId, threadId)
  if (!code) {
    await ctx.reply('❌ 找不到配對碼')
    return
  }

  let client: RelayClient | null = null
  try {
    client = await createRelayClient(port, code)
    await fn(client)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 遠端操作失敗: ${msg}`)
  } finally {
    client?.close()
  }
}

// --- File categorization ---

interface CategorizedFiles {
  readonly dirs: readonly string[]
  readonly videos: readonly string[]
  readonly images: readonly string[]
  readonly docs: readonly string[]
  readonly shortcuts: readonly string[]
  readonly others: readonly string[]
}

const VIDEO_EXT = new Set(['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.jfif', '.ico'])
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md'])

function getExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function categorize(raw: string): CategorizedFiles {
  const dirs: string[] = []
  const videos: string[] = []
  const images: string[] = []
  const docs: string[] = []
  const shortcuts: string[] = []
  const others: string[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('[dir] ')) {
      dirs.push(trimmed.slice(6))
    } else if (trimmed.startsWith('[file] ')) {
      const name = trimmed.slice(7)
      const ext = getExt(name)
      if (name === 'desktop.ini') continue
      if (ext === '.lnk') shortcuts.push(name.replace(/\.lnk$/, ''))
      else if (VIDEO_EXT.has(ext)) videos.push(name)
      else if (IMAGE_EXT.has(ext)) images.push(name)
      else if (DOC_EXT.has(ext)) docs.push(name)
      else others.push(name)
    }
  }

  return { dirs, videos, images, docs, shortcuts, others }
}

function formatCategory(emoji: string, label: string, items: readonly string[], maxShow = 8): string {
  if (items.length === 0) return ''
  const shown = items.slice(0, maxShow)
  const more = items.length > maxShow ? `\n  _...還有 ${items.length - maxShow} 個_` : ''
  return `${emoji} *${label}* (${items.length})\n  ${shown.join(', ')}${more}`
}

function formatListing(title: string, raw: string): string {
  const cat = categorize(raw)
  const total = cat.dirs.length + cat.videos.length + cat.images.length +
    cat.docs.length + cat.shortcuts.length + cat.others.length

  const sections = [
    `📂 *${title}* (${total} 項)`,
    '',
    formatCategory('📁', '資料夾', cat.dirs, 10),
    formatCategory('🔗', '捷徑', cat.shortcuts, 10),
    formatCategory('📄', '文件', cat.docs),
    formatCategory('🖼', '圖片', cat.images),
    formatCategory('🎬', '影片', cat.videos),
    formatCategory('📦', '其他', cat.others),
  ].filter(Boolean)

  return sections.join('\n\n')
}

// --- Commands ---

async function getHomeDir(client: RelayClient): Promise<string> {
  const raw = await client.call('remote_execute_command', { command: process.platform === 'win32' ? 'echo %USERPROFILE%' : 'echo $HOME' })
  return raw.trim()
}

async function desktopCommand(ctx: BotContext): Promise<void> {
  await withRelay(ctx, async (client) => {
    const home = await getHomeDir(client)
    const result = await client.call('remote_list_directory', { path: `${home}/Desktop` })
    const formatted = formatListing('桌面', result)
    await ctx.reply(formatted, { parse_mode: 'Markdown' })
  })
}

async function downloadsCommand(ctx: BotContext): Promise<void> {
  await withRelay(ctx, async (client) => {
    const home = await getHomeDir(client)
    const result = await client.call('remote_list_directory', { path: `${home}/Downloads` })
    const formatted = formatListing('下載', result)
    await ctx.reply(formatted, { parse_mode: 'Markdown' })
  })
}

async function lsCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const dirPath = text.replace(/^\/ls\s*/, '').trim() || '.'

  await withRelay(ctx, async (client) => {
    const result = await client.call('remote_list_directory', { path: dirPath })
    const title = dirPath === '.' ? '工作目錄' : dirPath.split(/[\\/]/).pop() || dirPath
    const formatted = formatListing(title, result)
    await ctx.reply(formatted, { parse_mode: 'Markdown' })
  })
}

async function rcatCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const filePath = text.replace(/^\/rcat\s*/, '').trim()

  if (!filePath) {
    await ctx.reply('用法: `/rcat 檔案路徑`', { parse_mode: 'Markdown' })
    return
  }

  await withRelay(ctx, async (client) => {
    const result = await client.call('remote_read_file', { path: filePath })
    const truncated = result.length > 3500
      ? result.slice(0, 3500) + '\n\n_...已截斷_'
      : result
    const name = filePath.split(/[\\/]/).pop() || filePath
    await ctx.reply(`📄 *${name}*\n\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' })
  })
}

async function rwriteCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const match = text.match(/^\/rwrite\s+(\S+)\s+([\s\S]+)/)

  if (!match) {
    await ctx.reply('用法: `/rwrite 檔案路徑 內容`', { parse_mode: 'Markdown' })
    return
  }

  const [, filePath, content] = match

  await withRelay(ctx, async (client) => {
    const result = await client.call('remote_write_file', { path: filePath, content })
    await ctx.reply(`✅ ${result}`)
  })
}

async function rinfoCommand(ctx: BotContext): Promise<void> {
  await withRelay(ctx, async (client) => {
    const cmds = [
      'hostname',
      'wmic os get Caption /value',
      'wmic cpu get Name /value',
      'wmic os get TotalVisibleMemorySize,FreePhysicalMemory /value',
    ]

    const results = await Promise.all(
      cmds.map((cmd) => client.call('remote_execute_command', { command: cmd }).catch(() => '未知'))
    )

    const [hostname, osRaw, cpuRaw, memRaw] = results

    const os = osRaw.match(/Caption=(.+)/)?.[1]?.trim() || '未知'
    const cpu = cpuRaw.match(/Name=(.+)/)?.[1]?.trim() || '未知'
    const totalKb = Number(memRaw.match(/TotalVisibleMemorySize=(\d+)/)?.[1] || 0)
    const freeKb = Number(memRaw.match(/FreePhysicalMemory=(\d+)/)?.[1] || 0)
    const totalGb = (totalKb / 1_048_576).toFixed(1)
    const freeGb = (freeKb / 1_048_576).toFixed(1)
    const usedPercent = totalKb > 0 ? (((totalKb - freeKb) / totalKb) * 100).toFixed(0) : '?'

    const info = [
      '🖥 *遠端系統資訊*',
      '',
      `*主機:* ${hostname.trim()}`,
      `*系統:* ${os}`,
      `*CPU:* ${cpu}`,
      `*記憶體:* ${freeGb} GB 可用 / ${totalGb} GB (${usedPercent}% 使用)`,
    ]

    await ctx.reply(info.join('\n'), { parse_mode: 'Markdown' })
  })
}

async function rexecCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const command = text.replace(/^\/rexec\s*/, '').trim()

  if (!command) {
    await ctx.reply('用法: `/rexec 指令`', { parse_mode: 'Markdown' })
    return
  }

  await withRelay(ctx, async (client) => {
    const result = await client.call('remote_execute_command', { command })
    const truncated = result.length > 3500
      ? result.slice(0, 3500) + '\n\n_...已截斷_'
      : result
    await ctx.reply(`\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' })
  })
}

// --- Plugin ---

const remotePlugin: Plugin = {
  name: 'remote',
  description: '遠端電腦操控面板',
  commands: [
    { name: 'desktop', description: '列出遠端桌面檔案', handler: desktopCommand },
    { name: 'downloads', description: '列出遠端下載資料夾', handler: downloadsCommand },
    { name: 'ls', description: '列出遠端目錄 (路徑)', handler: lsCommand },
    { name: 'rcat', description: '讀取遠端檔案 (路徑)', handler: rcatCommand },
    { name: 'rwrite', description: '寫入遠端檔案 (路徑 內容)', handler: rwriteCommand },
    { name: 'rinfo', description: '遠端系統資訊', handler: rinfoCommand },
    { name: 'rexec', description: '在遠端執行指令', handler: rexecCommand },
  ],
}

export default remotePlugin
