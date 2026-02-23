import { hostname, platform, arch, cpus, totalmem, freemem, uptime } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'

const execFileAsync = promisify(execFile)

function formatBytes(bytes: number): string {
  const gb = bytes / 1_073_741_824
  return `${gb.toFixed(1)} GB`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}時`)
  parts.push(`${mins}分`)
  return parts.join('')
}

async function getGpuInfo(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name',
    ], { timeout: 5_000, windowsHide: true })
    return stdout.trim() || '未知'
  } catch {
    return '未知'
  }
}

async function sysinfoCommand(ctx: BotContext): Promise<void> {
  const cpu = cpus()
  const cpuModel = cpu.length > 0 ? cpu[0].model : '未知'
  const cpuCores = cpu.length
  const totalMem = totalmem()
  const freeMem = freemem()
  const usedMem = totalMem - freeMem
  const memPercent = ((usedMem / totalMem) * 100).toFixed(0)

  const gpu = await getGpuInfo()

  const info = [
    `🖥️ *系統資訊*`,
    ``,
    `**主機:** ${hostname()}`,
    `**平台:** ${platform()} ${arch()}`,
    `**CPU:** ${cpuModel}`,
    `**核心:** ${cpuCores}`,
    `**GPU:** ${gpu}`,
    `**記憶體:** ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}%)`,
    `**可用:** ${formatBytes(freeMem)}`,
    `**開機時間:** ${formatUptime(uptime())}`,
  ].join('\n')

  await ctx.reply(info, { parse_mode: 'Markdown' })
}

const sysinfoPlugin: Plugin = {
  name: 'sysinfo',
  description: '系統資訊查看',
  commands: [
    {
      name: 'sysinfo',
      description: '查看系統資訊',
      handler: sysinfoCommand,
    },
  ],
}

export default sysinfoPlugin
