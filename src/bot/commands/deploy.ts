import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

export async function deployCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined
  const state = getUserState(chatId, threadId)
  const project = state.selectedProject

  if (!project) {
    await ctx.reply(
      '❌ 請先選擇專案。\n用 /projects 選擇專案。',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const commitMessage = raw.replace(/^\/deploy\s*/, '').trim()

  if (!commitMessage) {
    await ctx.reply(
      '用法: `/deploy <commit message>`\n\n範例:\n' +
      '`/deploy "fix: 修復登入 bug"`\n' +
      '`/deploy "feat: 新增語音辨識"`',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const projectDir = project.path

  // 檢查是否是 git repo
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    await ctx.reply(
      `❌ [${project.name}] 不是 Git 專案。\n無法執行部署。`
    )
    return
  }

  try {
    // 檢查是否有變更
    const status = execSync('git status --porcelain', {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    if (!status) {
      await ctx.reply(
        `ℹ️ [${project.name}] 沒有變更可提交。\n工作目錄乾淨。`
      )
      return
    }

    // 檢查是否有 unstaged changes
    const hasUnstaged = execSync('git diff --name-only', {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    const hasUntracked = execSync('git ls-files --others --exclude-standard', {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    const filesToAdd: string[] = []
    if (hasUnstaged) filesToAdd.push(...hasUnstaged.split('\n'))
    if (hasUntracked) filesToAdd.push(...hasUntracked.split('\n'))

    // Git add
    if (filesToAdd.length > 0) {
      execSync('git add -A', {
        cwd: projectDir,
        windowsHide: true,
      })
    }

    // Git commit
    const escapedMessage = commitMessage.replace(/"/g, '\\"')
    execSync(`git commit -m "${escapedMessage}"`, {
      cwd: projectDir,
      windowsHide: true,
    })

    // 取得 commit hash
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    // 取得當前 branch
    const branch = execSync('git branch --show-current', {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    // Git push
    execSync(`git push origin ${branch}`, {
      cwd: projectDir,
      windowsHide: true,
    })

    // 推播成功訊息
    await ctx.reply(
      `🚀 [${project.name}] 部署已觸發\n\n` +
      `📝 Commit: ${commitMessage}\n` +
      `🔖 Hash: ${commitHash}\n` +
      `🌿 Branch: ${branch}\n\n` +
      `⏳ CloudPipe 部署中，稍後將收到完成通知...`,
      { parse_mode: 'Markdown' }
    )
  } catch (error) {
    const err = error as Error & { stderr?: Buffer }
    const errorMessage = err.stderr?.toString() || err.message
    await ctx.reply(
      `❌ [${project.name}] 部署失敗\n\n` +
      `錯誤: ${errorMessage.slice(0, 200)}`,
      { parse_mode: 'Markdown' }
    )
  }
}
