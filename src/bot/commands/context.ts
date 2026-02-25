import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { addPin, getPins, removePin, clearPins } from '../context-pin-store.js'
import { getAISessionId, clearAISession } from '../../ai/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { basename } from 'node:path'

export async function contextCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.replace(/^\/context\s*/, '').trim()
  const msg = ctx.message
  const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.reply('⚠️ 尚未選擇專案。請先用 /projects。')
    return
  }

  const projectPath = state.selectedProject.path
  const projectName = state.selectedProject.name

  // /context pin <text>
  if (args.startsWith('pin ')) {
    const pinText = args.slice(4).trim()
    if (!pinText) {
      await ctx.reply('用法: `/context pin <要釘選的文字>`', { parse_mode: 'Markdown' })
      return
    }

    const item = addPin(projectPath, pinText)
    if (!item) {
      await ctx.reply('📌 釘選已滿（最多 10 則）。請先 `/context unpin <編號>` 移除舊的。', { parse_mode: 'Markdown' })
      return
    }

    const pins = getPins(projectPath)
    await ctx.reply(`📌 已釘選 #${pins.length}: ${item.text}`)
    return
  }

  // /context pins
  if (args === 'pins') {
    const pins = getPins(projectPath)
    if (pins.length === 0) {
      await ctx.reply(`*${projectName}* 沒有釘選的上下文。\n用 \`/context pin <文字>\` 新增。`, { parse_mode: 'Markdown' })
      return
    }

    const lines = pins.map((p, i) => `${i + 1}. ${p.text}`)
    await ctx.reply(
      `📌 *釘選上下文* — ${projectName}\n\n${lines.join('\n')}\n\n\`/context unpin <編號>\` 移除 | \`/context clear\` 全部清除`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  // /context unpin <number>
  if (args.startsWith('unpin ')) {
    const num = parseInt(args.slice(6).trim(), 10)
    if (isNaN(num) || num < 1) {
      await ctx.reply('用法: `/context unpin <編號>`', { parse_mode: 'Markdown' })
      return
    }

    const removed = removePin(projectPath, num - 1)
    if (!removed) {
      await ctx.reply(`無效的釘選編號: ${num}`)
      return
    }

    await ctx.reply(`🗑 已移除釘選 #${num}`)
    return
  }

  // /context clear
  if (args === 'clear') {
    const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
    clearAISession(resolvedBackend, projectPath)

    const pinCount = getPins(projectPath).length
    await ctx.reply(
      `🔄 已清除 *${projectName}* 的對話。\n` +
      (pinCount > 0 ? `📌 保留了 ${pinCount} 則釘選（用 \`/context clear pins\` 一併清除）。` : '📌 沒有釘選。') +
      '\n下次傳訊將開始新對話。',
      { parse_mode: 'Markdown' }
    )
    return
  }

  // /context clear pins
  if (args === 'clear pins') {
    const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
    clearAISession(resolvedBackend, projectPath)
    const cleared = clearPins(projectPath)

    await ctx.reply(
      `🔄 已清除 *${projectName}* 的對話 + ${cleared} 則釘選。\n下次傳訊將開始新對話。`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  // /context summary
  if (args === 'summary') {
    const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
    const sessionId = getAISessionId(resolvedBackend, projectPath)

    if (!sessionId) {
      await ctx.reply('⚠️ 目前沒有進行中的對話，無法產生摘要。')
      return
    }

    enqueue({
      chatId,
      prompt: '請用 3-5 個重點摘要我們目前的對話狀態：正在做什麼、做到哪裡、還有什麼待做。',
      project: state.selectedProject,
      ai: state.ai,
      sessionId,
      imagePaths: [],
    })

    await ctx.reply('📝 正在請 AI 摘要目前對話...')
    return
  }

  // /context (no args) — show status
  const resolvedBackend = state.ai.backend === 'auto' ? 'claude' : state.ai.backend
  const sessionId = getAISessionId(resolvedBackend, projectPath)
  const pins = getPins(projectPath)

  const sessionStatus = sessionId
    ? `✅ 有進行中的對話 (\`${sessionId.slice(0, 8)}...\`)`
    : '❌ 沒有進行中的對話'

  const pinStatus = pins.length > 0
    ? `📌 ${pins.length} 則釘選：\n${pins.map((p, i) => `  ${i + 1}. ${p.text}`).join('\n')}`
    : '📌 沒有釘選'

  await ctx.reply(
    `🧠 *上下文狀態* — ${projectName}\n\n` +
    `${sessionStatus}\n${pinStatus}\n\n` +
    '指令：\n' +
    '`/context pin <文字>` — 釘選重要上下文\n' +
    '`/context pins` — 列出所有釘選\n' +
    '`/context unpin <編號>` — 移除釘選\n' +
    '`/context summary` — AI 摘要目前對話\n' +
    '`/context clear` — 清除對話（保留釘選）\n' +
    '`/context clear pins` — 清除對話 + 釘選',
    { parse_mode: 'Markdown' }
  )
}
