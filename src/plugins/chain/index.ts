import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import type { ChainStep } from './chain-types.js'
import { listChains, getChain, saveChain, deleteChain, updateChainSchedule } from './chain-store.js'
import { runChain } from './chain-runner.js'

// --- Step parser ---

const STEP_PREFIXES = ['bv', 'pipe', 'notify', 'wait', 'cmd'] as const

function parseSteps(text: string): ChainStep[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const steps: ChainStep[] = []

  for (const line of lines) {
    // Check known prefixes: "bv ...", "pipe ...", "notify ...", "wait ...", "cmd ..."
    const prefix = STEP_PREFIXES.find((p) => {
      const lower = line.toLowerCase()
      return lower === p || lower.startsWith(p + ' ')
    })

    if (prefix) {
      const instruction = line.slice(prefix.length).trim()
      steps.push({ type: prefix, instruction })
    } else if (line.startsWith('/')) {
      // Bot command: "/deploy", "/schedule list"
      steps.push({ type: 'cmd', instruction: line })
    } else if (steps.length > 0) {
      // No prefix — append to previous step's instruction (continuation line)
      const prev = steps[steps.length - 1]
      steps[steps.length - 1] = { ...prev, instruction: `${prev.instruction} ${line}` }
    } else {
      // First line with no prefix — treat as notify
      steps.push({ type: 'notify', instruction: line })
    }
  }

  return steps
}

// --- Scheduler ---

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let telegramRef: import('telegraf').Telegram | null = null
let lastTriggeredMinute = ''

function startScheduler(): void {
  if (schedulerInterval) return

  schedulerInterval = setInterval(() => {
    if (!telegramRef) return

    const now = new Date()
    const currentMinute = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

    // Prevent double-trigger within the same minute
    if (currentMinute === lastTriggeredMinute) return
    lastTriggeredMinute = currentMinute

    const chains = listChains()
    for (const chain of chains) {
      if (chain.schedule === currentMinute) {
        const tg = telegramRef
        runChain(chain, chain.chatId, tg)
          .then((result) => {
            if (result.success) {
              tg.sendMessage(chain.chatId,
                `✅ Chain "${chain.name}" 排程完成 (${result.stepResults.length} 步)`,
              ).catch(() => {})
            }
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            tg.sendMessage(chain.chatId,
              `❌ Chain "${chain.name}" 排程失敗: ${msg}`,
            ).catch(() => {})
          })
      }
    }
  }, 60_000)
}

function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
}

// --- Command handler ---

async function chainCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Store telegram reference for scheduler
  if (!telegramRef) {
    telegramRef = ctx.telegram
  }

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const afterCmd = text.replace(/^\/chain\s*/i, '')

  // Parse subcommand from first line
  const firstNewline = afterCmd.indexOf('\n')
  const firstLine = firstNewline === -1 ? afterCmd.trim() : afterCmd.slice(0, firstNewline).trim()
  const restLines = firstNewline === -1 ? '' : afterCmd.slice(firstNewline + 1).trim()

  const parts = firstLine.split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''

  // /chain (no args) — show list, or usage hint if empty
  if (!sub || sub === 'list') {
    const chains = listChains()
    if (chains.length === 0) {
      await ctx.reply(
        '⛓️ 目前沒有 chain\n\n' +
        '用 `/chain create 名稱` 建立，換行寫步驟\n' +
        '步驟前綴: `bv` `pipe` `notify` `wait` `/指令`\n' +
        '變數: `{{prev}}` `{{step.N}}`',
        { parse_mode: 'Markdown' },
      )
      return
    }

    const lines = ['⛓️ *Chain 列表*', '']
    for (const c of chains) {
      const schedLabel = c.schedule ? ` ⏰ ${c.schedule}` : ''
      lines.push(`• *${c.name}* — ${c.steps.length} 步${schedLabel}`)
    }
    lines.push('')
    lines.push('`/chain run <名稱>` 執行 · `/chain info <名稱>` 詳情')
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
    return
  }

  // /chain create <name>\n<steps>
  if (sub === 'create') {
    const name = parts.slice(1).join(' ')
    if (!name) {
      await ctx.reply('⚠️ 請指定 chain 名稱\n\n用法: `/chain create 名稱`\n(後面多行是步驟)', { parse_mode: 'Markdown' })
      return
    }
    if (!restLines) {
      await ctx.reply('⚠️ 請在名稱之後換行，輸入步驟\n\n範例:\n```\n/chain create 測試\nnotify hello\nwait 2\nnotify done\n```', { parse_mode: 'Markdown' })
      return
    }

    const steps = parseSteps(restLines)
    if (steps.length === 0) {
      await ctx.reply('⚠️ 沒有解析到任何步驟')
      return
    }

    const chain = {
      name,
      steps,
      chatId,
      createdAt: new Date().toISOString(),
    }
    saveChain(chain)

    const stepList = steps.map((s, i) => `  ${i + 1}. \`${s.type}\` ${s.instruction}`).join('\n')
    await ctx.reply(
      `✅ Chain "${name}" 已建立 (${steps.length} 步)\n\n${stepList}\n\n點擊複製執行：\n\`/chain run ${name}\``,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // /chain info <name>
  if (sub === 'info') {
    const name = parts.slice(1).join(' ')
    if (!name) {
      await ctx.reply('⚠️ 用法: `/chain info <名稱>`', { parse_mode: 'Markdown' })
      return
    }

    const chain = getChain(name)
    if (!chain) {
      await ctx.reply(`❌ 找不到 chain "${name}"`)
      return
    }

    const stepList = chain.steps.map((s, i) => `  ${i + 1}. \`${s.type}\` ${s.instruction}`).join('\n')
    const schedInfo = chain.schedule ? `\n⏰ 排程: 每日 ${chain.schedule}` : ''
    await ctx.reply(
      `⛓️ *Chain: ${chain.name}*\n\n${stepList}${schedInfo}\n\n建立: ${chain.createdAt}`,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // /chain run <name>
  if (sub === 'run') {
    const name = parts.slice(1).join(' ')
    if (!name) {
      await ctx.reply('⚠️ 用法: `/chain run <名稱>`', { parse_mode: 'Markdown' })
      return
    }

    const chain = getChain(name)
    if (!chain) {
      await ctx.reply(`❌ 找不到 chain "${name}"`)
      return
    }

    await ctx.reply(`⛓️ 開始執行 "${name}"...`)

    const result = await runChain(chain, chatId, ctx.telegram)

    if (result.success) {
      const summary = result.stepResults
        .map((r, i) => `  ${i + 1}. ✅ ${r.type} (${r.durationMs}ms)`)
        .join('\n')
      await ctx.reply(`✅ Chain "${name}" 完成\n\n${summary}`)
    } else {
      await ctx.reply(`❌ Chain "${name}" 失敗: ${result.error ?? '未知錯誤'}`)
    }
    return
  }

  // /chain schedule <name> <HH:MM>
  if (sub === 'schedule') {
    const name = parts.slice(1, -1).join(' ')
    const time = parts[parts.length - 1]

    if (!name || !time || !/^\d{1,2}:\d{2}$/.test(time)) {
      await ctx.reply('⚠️ 用法: `/chain schedule <名稱> <HH:MM>`', { parse_mode: 'Markdown' })
      return
    }

    const chain = getChain(name)
    if (!chain) {
      await ctx.reply(`❌ 找不到 chain "${name}"`)
      return
    }

    const [h, m] = time.split(':')
    const normalized = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
    updateChainSchedule(name, normalized)
    startScheduler()

    await ctx.reply(`⏰ Chain "${name}" 已排程每日 *${normalized}* 執行`, { parse_mode: 'Markdown' })
    return
  }

  // /chain unschedule <name>
  if (sub === 'unschedule') {
    const name = parts.slice(1).join(' ')
    if (!name) {
      await ctx.reply('⚠️ 用法: `/chain unschedule <名稱>`', { parse_mode: 'Markdown' })
      return
    }

    const ok = updateChainSchedule(name, undefined)
    if (!ok) {
      await ctx.reply(`❌ 找不到 chain "${name}"`)
      return
    }

    await ctx.reply(`✅ Chain "${name}" 排程已取消`)
    return
  }

  // /chain delete <name>
  if (sub === 'delete') {
    const name = parts.slice(1).join(' ')
    if (!name) {
      await ctx.reply('⚠️ 用法: `/chain delete <名稱>`', { parse_mode: 'Markdown' })
      return
    }

    const ok = deleteChain(name)
    if (!ok) {
      await ctx.reply(`❌ 找不到 chain "${name}"`)
      return
    }

    await ctx.reply(`✅ Chain "${name}" 已刪除`)
    return
  }

  // Unknown subcommand
  await ctx.reply(`⚠️ 未知子指令: ${sub}\n\n用 \`/chain\` 查看用法`, { parse_mode: 'Markdown' })
}

// --- Service lifecycle ---

async function start(): Promise<void> {
  const chains = listChains()
  const hasScheduled = chains.some((c) => c.schedule)
  if (hasScheduled) {
    startScheduler()
  }
}

async function stop(): Promise<void> {
  stopScheduler()
}

// --- Plugin export ---

const chainPlugin: Plugin = {
  name: 'chain',
  description: '指令鏈系統 — 串聯指令自動執行',
  commands: [
    {
      name: 'chain',
      description: '管理指令鏈（建立/執行/排程/刪除）',
      handler: chainCommand,
    },
  ],
  service: { start, stop },
}

export default chainPlugin
