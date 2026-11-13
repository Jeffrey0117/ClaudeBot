import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { findCapability } from '../cloudpipe-client.js'
import { formatFindResult } from '../x1-format.js'
import { readDotRepo, formatDotRepoDetail } from '../../config/dotrepo.js'

const FIND_LIMIT = 5
const TASK_MAX = 300

function argsOf(ctx: BotContext): string {
  const raw = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  return raw.replace(/^\/\S+\s*/, '').trim()
}

function threadIdOf(ctx: BotContext): number | undefined {
  return ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined
}

/** /x1 <想做的事> — ask X1 which project can do something, without reading any of them. */
export async function x1Command(ctx: BotContext): Promise<void> {
  const task = argsOf(ctx).slice(0, TASK_MAX)
  if (!task) {
    await ctx.reply('用法: /x1 <想做的事>\n例: /x1 上傳圖片拿短網址')
    return
  }

  try {
    const res = await findCapability(task, FIND_LIMIT)
    if (res.notReady) {
      await ctx.reply('⚠️ 連不上 CloudPipe，X1 暫時不能查。')
      return
    }
    if (!res.ok) {
      await ctx.reply(`❌ X1 查詢失敗：${res.error ?? '未知錯誤'}`)
      return
    }
    await ctx.reply(formatFindResult(task, res.data), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  } catch (error) {
    console.error('[x1] find failed:', error)
    await ctx.reply('❌ X1 查詢失敗，請稍後再試。')
  }
}

/** /repo — show the selected project's own description (.repo). */
export async function repoCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const project = getUserState(chatId, threadIdOf(ctx)).selectedProject
  if (!project) {
    await ctx.reply('❌ 請先用 /projects 選擇專案。')
    return
  }

  const summary = readDotRepo(project.path)
  if (!summary) {
    await ctx.reply(`${project.name} 沒有 .repo 檔（或格式讀不懂）。\n在專案裡跑 dotrepo init 可以建立。`)
    return
  }

  await ctx.reply(formatDotRepoDetail(project.name, summary), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
}
