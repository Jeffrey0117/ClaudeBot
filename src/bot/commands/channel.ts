import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isChannelEnabled, setChannelEnabled } from '../../ai/channel/opt-in-store.js'
import { isChannelRunning } from '../../ai/channel/channel-runner.js'
import { isRemotePath } from '../../remote/pairing-store.js'

export async function channelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message?.message_thread_id
  const project = getUserState(chatId, threadId).selectedProject
  if (!project) {
    await ctx.reply('先用 /select 選一個專案。')
    return
  }
  const arg = (ctx.message && 'text' in ctx.message ? ctx.message.text : '')
    .replace(/^\/channel(@\S+)?\s*/i, '').trim().toLowerCase()

  if (arg === 'on') {
    setChannelEnabled(project.path, true)
    await ctx.reply(`✅ *${project.name}* 開啟常駐 channel session（可中斷、可邊跑邊補充）。`, { parse_mode: 'Markdown' })
    return
  }
  if (arg === 'off') {
    setChannelEnabled(project.path, false)
    await ctx.reply(`↩️ *${project.name}* 關閉 channel，改走預設 -p 路線。`, { parse_mode: 'Markdown' })
    return
  }
  const remote = isRemotePath(project.path)
  const on = isChannelEnabled(project.path)
  const running = isChannelRunning(project.path)
  await ctx.reply(
    `*${project.name}* channel: ${on ? '✅ on（預設）' : remote ? '🚫 remote 不支援（Phase 2b）' : '⬜ off'}\n` +
    `session: ${running ? '🟢 回合進行中' : '⚪ idle / 未啟動'}\n\n` +
    `本機專案預設全開。用 /channel off 關閉這個專案、/channel on 重新開啟。`,
    { parse_mode: 'Markdown' },
  )
}
