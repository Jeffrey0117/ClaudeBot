/**
 * Playbook subcommand handlers for /bv command.
 * Save, play, list, info, delete playbooks.
 */

import type { BotContext } from '../../types/context.js'
import {
  getActiveAgent,
  setActiveAgent,
  getLastResult,
  setLastResult,
} from '../vision/web-agent-store.js'
import {
  savePlaybook,
  getPlaybook,
  listPlaybooks,
  deletePlaybook,
  extractPlaybookActions,
} from '../vision/playbook-store.js'
import { runPlaybook } from '../vision/playbook-runner.js'
import { autoSplitSteps } from '../../ai/gemini-agent-vision.js'

const PLAYBOOK_NAME_RE = /^[\w\u4e00-\u9fff\-]{1,50}$/

export function isValidPlaybookName(name: string): boolean {
  return PLAYBOOK_NAME_RE.test(name)
}

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export async function handleSavePlaybook(
  ctx: BotContext,
  chatId: number,
  name: string,
): Promise<void> {
  const lastResult = getLastResult(chatId)
  if (!lastResult) {
    await ctx.reply('沒有最近的自動化結果可儲存。\n請先執行 `/bv <URL> <指令>`', { parse_mode: 'Markdown' })
    return
  }

  if (!lastResult.success) {
    await ctx.reply('上次執行未成功，建議只儲存成功的流程。')
    return
  }

  // Filter out replay steps — they're already saved as playbooks
  const freshSteps = lastResult.steps.filter((s) => !s.isReplay && s.action.type !== 'use_playbook')
  const allActions = extractPlaybookActions(freshSteps)
  if (allActions.length === 0) {
    await ctx.reply('上次執行沒有新動作可儲存（全為已有的 playbook 回放）。')
    return
  }

  // Validate name prefix if given
  if (name && !isValidPlaybookName(name)) {
    await ctx.reply('Playbook 名稱只能使用英數字、中文、底線、連字號 (最長50字)')
    return
  }

  // --- Always auto-split (name is used as prefix if provided) ---
  const statusMsg = await ctx.reply('🔍 AI 分析步驟，自動拆分 playbook...')

  const splitResult = await autoSplitSteps(lastResult.url, lastResult.instruction, freshSteps)

  if (splitResult.error || splitResult.groups.length === 0) {
    // Fallback: save as single playbook
    const domain = new URL(lastResult.url).hostname.replace(/^www\./, '').split('.')[0]
    const fallbackName = name || `${domain}-自動化`
    savePlaybook({
      name: fallbackName,
      url: lastResult.url,
      instruction: lastResult.instruction,
      actions: allActions,
      createdAt: new Date().toISOString(),
      chatId,
    })
    await ctx.reply(
      `📋 自動儲存為 "${fallbackName}" (拆分失敗，存為單一 playbook)\n` +
      `📊 ${allActions.length} 動作`,
    )
    return
  }

  // Save each group as a separate playbook
  const savedNames: string[] = []
  const nonDoneSteps = freshSteps.filter((s) => s.action.type !== 'done')

  for (const group of splitResult.groups) {
    const start = Math.max(0, group.startIndex)
    const end = Math.min(nonDoneSteps.length - 1, group.endIndex)
    const groupSteps = nonDoneSteps.slice(start, end + 1)
    const groupActions = extractPlaybookActions(groupSteps)

    if (groupActions.length === 0) continue

    // Build instruction from the steps' thoughts
    const groupInstruction = group.description

    const groupName = name ? `${name}-${group.name}` : group.name

    savePlaybook({
      name: groupName,
      url: lastResult.url,
      instruction: groupInstruction,
      actions: groupActions,
      createdAt: new Date().toISOString(),
      chatId,
    })

    savedNames.push(groupName)
  }

  if (savedNames.length === 0) {
    await ctx.reply('拆分後沒有有效的 playbook 可儲存。')
    return
  }

  const lines = savedNames.map((n, i) => {
    const pb = getPlaybook(n)
    const fillCount = pb?.actions.filter((a) => a.type === 'fill').length ?? 0
    return `${i + 1}. 📋 ${n} — ${pb?.actions.length ?? 0} 動作${fillCount > 0 ? ` (${fillCount} 填入)` : ''}`
  })

  try {
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `✅ 自動拆分完成，存成 ${savedNames.length} 個 playbook:\n\n` +
      lines.join('\n') +
      '\n\n下次相同操作時 AI 會自動使用這些 playbook',
    )
  } catch {
    await ctx.reply(
      `✅ 自動拆分完成，存成 ${savedNames.length} 個 playbook:\n\n` +
      lines.join('\n'),
    )
  }
}

export async function handlePlayPlaybook(
  ctx: BotContext,
  chatId: number,
  argsStr: string,
): Promise<void> {
  // Parse: first word is playbook name, rest is optional new instruction
  const parts = argsStr.split(/\s+/)
  const name = parts[0]
  const newInstruction = parts.slice(1).join(' ').trim() || undefined

  if (!name || !isValidPlaybookName(name)) {
    await ctx.reply('用法: `/bv play <名稱> [新指令]`', { parse_mode: 'Markdown' })
    return
  }

  const playbook = getPlaybook(name)
  if (!playbook) {
    await ctx.reply(`找不到 playbook "${name}"。\n用 \`/bv playbooks\` 查看所有 playbook。`, { parse_mode: 'Markdown' })
    return
  }

  if (getActiveAgent(chatId)) {
    await ctx.reply('⚠️ 已有進行中的自動化任務。\n用 `/bv cancel` 取消後再試。', { parse_mode: 'Markdown' })
    return
  }

  const fillCount = playbook.actions.filter((a) => a.type === 'fill').length
  const statusMsg = await ctx.reply(
    `▶️ 回放 "${name}"...\n` +
    `🌐 ${playbook.url}\n` +
    `📊 ${playbook.actions.length} 動作` +
    (fillCount > 0 && newInstruction ? ` (提取 ${fillCount} 個新值)` : ''),
  )

  const abortController = new AbortController()

  setActiveAgent(chatId, {
    chatId,
    url: playbook.url,
    instruction: newInstruction ?? playbook.instruction,
    abortController,
    startedAt: Date.now(),
    currentStep: 0,
    statusMessageId: statusMsg.message_id,
  })

  try {
    const result = await runPlaybook({
      chatId,
      playbook,
      newInstruction,
      statusMessageId: statusMsg.message_id,
      telegram: ctx.telegram,
      abortSignal: abortController.signal,
    })

    const stepsText = result.steps
      .map((s, i) => `${i + 1}. ${s.thought}`)
      .join('\n')

    const icon = result.success ? '✅' : '⚠️'
    const summaryText = (
      `${icon} *Playbook 回放完成*\n\n` +
      `📋 ${escapeMd(name)}\n` +
      `🌐 ${escapeMd(playbook.url)}\n` +
      `📊 ${result.steps.length} 步驟\n\n` +
      `*結果:* ${escapeMd(result.summary)}\n\n` +
      `*步驟記錄:*\n${escapeMd(stepsText)}`
    )

    try {
      await ctx.reply(summaryText, { parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.reply(
        `${icon} Playbook 回放完成\n\n` +
        `📋 ${name}\n` +
        `🌐 ${playbook.url}\n` +
        `📊 ${result.steps.length} 步驟\n\n` +
        `結果: ${result.summary}\n\n` +
        `步驟記錄:\n${stepsText}`,
      )
    }

    if (result.finalScreenshot) {
      try {
        const buf = Buffer.from(result.finalScreenshot, 'base64')
        await ctx.replyWithPhoto({ source: buf, filename: 'final.png' })
      } catch {
        // ignore
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 回放失敗: ${msg}`)
  }
}

export async function handleListPlaybooks(ctx: BotContext): Promise<void> {
  const all = listPlaybooks()
  if (all.length === 0) {
    await ctx.reply('📋 沒有儲存的 playbook。\n先執行 `/bv <URL> <指令>` 再用 `/bv save <名稱>` 儲存。', { parse_mode: 'Markdown' })
    return
  }

  const lines = all.map((p) => {
    const fillCount = p.actions.filter((a) => a.type === 'fill').length
    const date = p.createdAt.slice(0, 10)
    return (
      `📋 *${escapeMd(p.name)}*\n` +
      `   🌐 ${escapeMd(p.url)}\n` +
      `   📊 ${p.actions.length} 動作` +
      (fillCount > 0 ? ` \\(${fillCount} 填入\\)` : '') +
      ` \\| ${escapeMd(date)}`
    )
  })

  try {
    await ctx.reply(lines.join('\n\n'), { parse_mode: 'MarkdownV2' })
  } catch {
    const plain = all.map((p) => {
      const fillCount = p.actions.filter((a) => a.type === 'fill').length
      return `📋 ${p.name} — ${p.url} — ${p.actions.length} 動作${fillCount > 0 ? ` (${fillCount} 填入)` : ''}`
    })
    await ctx.reply(plain.join('\n'))
  }
}

export async function handlePlaybookInfo(ctx: BotContext, name: string): Promise<void> {
  if (!name || !isValidPlaybookName(name)) {
    await ctx.reply('用法: `/bv playbook info <名稱>`', { parse_mode: 'Markdown' })
    return
  }

  const pb = getPlaybook(name)
  if (!pb) {
    await ctx.reply(`找不到 playbook "${name}"`)
    return
  }

  const stepsText = pb.actions
    .map((a, i) => {
      const detail = a.type === 'fill'
        ? `填入 "${a.fieldLabel ?? a.selector ?? '?'}" → "${a.text ?? ''}"`
        : a.type === 'click' ? `點擊 ${a.selector ?? ''}`
        : a.type === 'click_xy' ? `座標點擊 (${a.x}, ${a.y})`
        : a.type === 'deep_click' ? `深層點擊 "${a.text ?? ''}"`
        : a.type === 'press' ? `按鍵 ${a.text ?? ''}`
        : a.type === 'scroll' ? `捲動 ${a.text ?? 'down'}`
        : a.type === 'navigate' ? `導航 ${a.text ?? ''}`
        : a.type
      return `${i + 1}. ${a.type} — ${detail}`
    })
    .join('\n')

  const fillCount = pb.actions.filter((a) => a.type === 'fill').length
  await ctx.reply(
    `📋 Playbook: ${pb.name}\n` +
    `🌐 ${pb.url}\n` +
    `📊 ${pb.actions.length} 動作${fillCount > 0 ? ` (${fillCount} 填入)` : ''}\n` +
    `📅 ${pb.createdAt.slice(0, 10)}\n\n` +
    `步驟:\n${stepsText}`,
  )
}

export async function handleDeletePlaybook(ctx: BotContext, name: string): Promise<void> {
  if (!name || !isValidPlaybookName(name)) {
    await ctx.reply('用法: `/bv playbook delete <名稱>`', { parse_mode: 'Markdown' })
    return
  }

  if (deletePlaybook(name)) {
    await ctx.reply(`🗑️ Playbook "${name}" 已刪除`)
  } else {
    await ctx.reply(`找不到 playbook "${name}"`)
  }
}
