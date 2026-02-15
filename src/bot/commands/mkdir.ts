import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotContext } from '../../types/context.js'
import { getBaseDirs } from '../../config/projects.js'

const VALID_NAME = /^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/

export async function mkdirCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/mkdir\s*/, '').trim()

  if (!name) {
    await ctx.reply('用法: /mkdir `<專案名稱>`\n例如: /mkdir my-new-app', { parse_mode: 'Markdown' })
    return
  }

  if (!VALID_NAME.test(name)) {
    await ctx.reply('專案名稱只能包含英文、數字、底線、連字號和中文。')
    return
  }

  if (name.length > 100) {
    await ctx.reply('專案名稱太長，最多 100 字元。')
    return
  }

  const baseDir = getBaseDirs()[0]
  if (!baseDir) {
    await ctx.reply('❌ 未設定專案目錄。')
    return
  }
  const projectPath = join(baseDir, name)

  // Prevent path traversal
  if (!projectPath.startsWith(baseDir)) {
    await ctx.reply('無效的專案名稱。')
    return
  }

  try {
    await mkdir(projectPath, { recursive: false })
    await ctx.reply(`✅ 已建立專案: \`${name}\`\n用 /projects 選擇它`, { parse_mode: 'Markdown' })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      await ctx.reply(`❌ 專案 \`${name}\` 已經存在。`, { parse_mode: 'Markdown' })
      return
    }
    console.error('[mkdir] Failed to create directory:', error)
    await ctx.reply('❌ 建立失敗，請稍後再試。')
  }
}
