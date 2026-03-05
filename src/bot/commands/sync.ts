import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { isGitRepo, isWorktree, mainRepoPath, syncAllWorktrees } from '../../git/worktree.js'

export async function syncCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject

  if (!project) {
    await ctx.reply('❌ 請先選擇專案。\n用 /projects 選擇專案。')
    return
  }

  const projectDir = project.path
  if (!isGitRepo(projectDir)) {
    await ctx.reply(`❌ [${project.name}] 不是 Git 專案。`)
    return
  }

  // Find the main repo path (works from both worktree and main repo)
  const mainDir = isWorktree(projectDir)
    ? mainRepoPath(projectDir)
    : projectDir

  if (!mainDir) {
    await ctx.reply('❌ 找不到主倉庫路徑。')
    return
  }

  await ctx.reply('🔄 同步所有 worktree...')

  try {
    const results = syncAllWorktrees(mainDir)

    if (results.length === 0) {
      await ctx.reply('ℹ️ 沒有其他 worktree 需要同步。')
      return
    }

    const lines = results.map((r) => {
      if (r.success) {
        const icon = r.strategy === 'clean' ? '⏭️' : '✅'
        const label = r.strategy === 'clean' ? 'up to date' : 'smart-merged + tsc ✓'
        return `${icon} ${r.branch}: ${label}`
      }
      const icon = r.strategy === 'typecheck-fail' ? '⚠️' : '❌'
      return `${icon} ${r.branch}: ${r.message}`
    })
    const successCount = results.filter((r) => r.success).length
    await ctx.reply(
      `🔄 Smart Sync 完成 (${successCount}/${results.length})\n\n${lines.join('\n')}`
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ 同步失敗: ${msg.slice(0, 200)}`)
  }
}
