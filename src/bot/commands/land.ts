import type { BotContext } from '../../types/context.js'
import { execSync, execFileSync } from 'node:child_process'
import { getUserState } from '../state.js'
import { isGitRepo, isWorktree, mainRepoPath, mergeToMain } from '../../git/worktree.js'

/**
 * /land — land the bot's worktree work onto master.
 *
 * The bot runs on a worktree branch (bot1, bot2…) and AUTO_COMMIT commits its
 * work there, invisible to master (which is why "local Claude" never sees bot
 * edits). This commits any pending changes, merges the current worktree branch
 * into master, and pushes — so bot-made fixes become real/permanent — WITHOUT
 * the heavy parts of /deploy (no build, no remote-sync, no visual regression).
 *
 * Counterpart to /sync, which goes the other way (master → all worktrees).
 */
export async function landCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject
  if (!project) {
    await ctx.reply('❌ 請先用 /projects 選擇專案。')
    return
  }

  const projectDir = project.path
  if (!isGitRepo(projectDir)) {
    await ctx.reply(`❌ [${project.name}] 不是 Git 專案。`)
    return
  }

  const sh = (cmd: string): string =>
    execSync(cmd, { cwd: projectDir, encoding: 'utf8', windowsHide: true }).trim()

  try {
    const branch = sh('git branch --show-current')
    if (branch === 'master' || branch === 'main') {
      await ctx.reply('ℹ️ 已在 master，無需 land（要推送用 /deploy）。')
      return
    }

    // 1. Commit any pending changes first
    const dirty = sh('git status --porcelain')
    if (dirty) {
      execSync('git add -A', { cwd: projectDir, windowsHide: true })
      execFileSync('git', ['commit', '-m', `land: ${branch} 併入 master`], {
        cwd: projectDir, windowsHide: true,
      })
    }

    // 2. Anything ahead of master?
    if (sh('git rev-list master..HEAD --count') === '0' && !dirty) {
      await ctx.reply(`ℹ️ [${branch}] 沒有領先 master 的改動，無需 land。`)
      return
    }

    // 3. Merge worktree branch → master (in the main repo) + push
    if (!isWorktree(projectDir)) {
      await ctx.reply('ℹ️ 這不是 worktree。直接 /deploy 推送即可。')
      return
    }
    const mainDir = mainRepoPath(projectDir)
    if (!mainDir) {
      await ctx.reply('❌ 找不到主倉庫路徑，無法合併。')
      return
    }

    await ctx.reply(`🔀 [${branch}] → master 合併中…`)
    const merge = mergeToMain(mainDir, branch)
    if (!merge.success) {
      const conflicts = merge.conflicts?.length
        ? `\n衝突檔案:\n${merge.conflicts.map((f) => `  - ${f}`).join('\n')}`
        : ''
      await ctx.reply(`❌ 合併失敗: ${merge.message}${conflicts}\n（請手動處理衝突後再試）`)
      return
    }

    execFileSync('git', ['push', 'origin', 'master'], { cwd: mainDir, windowsHide: true })

    await ctx.reply(
      `✅ [${branch}] 已併回 master 並推送。\n` +
      `bot 在這條分支的改動現在是 master 的永久內容了。`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`⚠️ land 失敗: ${msg.slice(0, 300)}`)
  }
}
