import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isChannelOptIn, setChannelOptIn } from '../../ai/channel/opt-in-store.js'
import { isChannelRunning } from '../../ai/channel/channel-runner.js'

export async function channelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message?.message_thread_id
  const project = getUserState(chatId, threadId).selectedProject
  if (!project) {
    await ctx.reply('先用 /select 選一個專案再開 channel。')
    return
  }
  const arg = (ctx.message && 'text' in ctx.message ? ctx.message.text : '')
    .replace(/^\/channel(@\S+)?\s*/i, '').trim().toLowerCase()

  if (arg === 'on') {
    setChannelOptIn(project.path, true)
    await ctx.reply(`✅ *${project.name}* 已切到常駐 channel session（可中斷、可邊跑邊補充）。`, { parse_mode: 'Markdown' })
    return
  }
  if (arg === 'off') {
    setChannelOptIn(project.path, false)
    await ctx.reply(`↩️ *${project.name}* 切回預設 -p 路線。`, { parse_mode: 'Markdown' })
    return
  }
  const on = isChannelOptIn(project.path)
  const running = isChannelRunning(project.path)
  await ctx.reply(
    `*${project.name}* channel: ${on ? '✅ on' : '⬜ off'}\n` +
    `session: ${running ? '🟢 回合進行中' : '⚪ idle / 未啟動'}\n\n` +
    `用法: /channel on｜/channel off`,
    { parse_mode: 'Markdown' },
  )
}
