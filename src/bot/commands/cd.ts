import { resolve, basename } from 'node:path'
import { statSync } from 'node:fs'
import type { BotContext } from '../../types/context.js'
import { isPathSafe } from '../../utils/path-validator.js'
import { getUserState, setUserProject } from '../state.js'

export async function cdCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const arg = raw.replace(/^\/cd\s*/, '').trim()

  if (!arg) {
    const state = getUserState(chatId)
    const current = state.selectedProject?.path ?? '（未選擇）'
    await ctx.reply(`📂 目前目錄: \`${current}\`\n\n用法: /cd \`<路徑>\`\n例如:\n/cd src\n/cd ..\n/cd C:\\\\Users\\\\jeffb\\\\Desktop\\\\code\\\\MyApp`, { parse_mode: 'Markdown' })
    return
  }

  const state = getUserState(chatId)
  const currentDir = state.selectedProject?.path

  // Resolve path: relative to current project dir, or absolute
  let targetPath: string
  if (currentDir && !isAbsolute(arg)) {
    targetPath = resolve(currentDir, arg)
  } else {
    targetPath = resolve(arg)
  }

  // Validate within allowed base dirs
  if (!isPathSafe(targetPath)) {
    await ctx.reply('❌ 該路徑不在允許的目錄範圍內。')
    return
  }

  // Check if path exists and is a directory
  try {
    const stat = statSync(targetPath)
    if (!stat.isDirectory()) {
      await ctx.reply('❌ 該路徑不是一個目錄。')
      return
    }
  } catch {
    await ctx.reply('❌ 該路徑不存在。')
    return
  }

  const projectName = basename(targetPath)
  setUserProject(chatId, { name: projectName, path: targetPath })

  await ctx.reply(`📂 已切換到: \`${targetPath}\``, { parse_mode: 'Markdown' })
}

function isAbsolute(p: string): boolean {
  // Windows: C:\, D:\, \\server, etc.
  // Unix: /
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}
