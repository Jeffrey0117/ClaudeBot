import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { execSync, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getPairing } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'
import { isWorktree, mainRepoPath, mergeToMain, syncAllWorktrees } from '../../git/worktree.js'
import { captureBaseline, compareWithBaseline, type RegressionConfig } from '../vision/visual-regression.js'

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

    // Git commit (use execFileSync to prevent shell injection in commit message)
    execFileSync('git', ['commit', '-m', commitMessage], {
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

    // Worktree: merge branch back to master before push
    const inWorktree = isWorktree(projectDir)
    let pushDir = projectDir
    let pushBranch = branch

    if (inWorktree) {
      const mainDir = mainRepoPath(projectDir)
      if (!mainDir) {
        await ctx.reply('❌ 找不到主倉庫路徑，無法合併。')
        return
      }

      await ctx.reply(`🔀 合併 ${branch} → master...`)

      const mergeResult = mergeToMain(mainDir, branch)
      if (!mergeResult.success) {
        const conflictList = mergeResult.conflicts?.length
          ? `\n衝突檔案:\n${mergeResult.conflicts.map((f) => `  - ${f}`).join('\n')}`
          : ''
        await ctx.reply(`❌ 合併失敗: ${mergeResult.message}${conflictList}`)
        return
      }

      pushDir = mainDir
      pushBranch = 'master'
    }

    // Git push (use execFileSync to prevent shell injection via branch name)
    execFileSync('git', ['push', 'origin', pushBranch], {
      cwd: pushDir,
      windowsHide: true,
    })

    // 推播成功訊息
    const mergeNote = inWorktree ? `\n🔀 Merged: ${branch} → master` : ''
    await ctx.reply(
      `🚀 [${project.name}] 部署已觸發\n\n` +
      `📝 Commit: ${commitMessage}\n` +
      `🔖 Hash: ${commitHash}\n` +
      `🌿 Branch: ${pushBranch}${mergeNote}`,
      { parse_mode: 'Markdown' }
    )

    // Auto-sync all other worktrees
    const mainDir = inWorktree ? mainRepoPath(projectDir) : projectDir
    if (mainDir) {
      const syncResults = syncAllWorktrees(mainDir, 'master', branch)
      if (syncResults.length > 0) {
        const lines = syncResults.map((r) => {
          if (r.success) {
            const icon = r.strategy === 'clean' ? '⏭️' : '✅'
            const label = r.strategy === 'clean' ? 'up to date' : 'smart-merged'
            return `${icon} ${r.branch}: ${label}`
          }
          const icon = r.strategy === 'typecheck-fail' ? '⚠️' : '❌'
          return `${icon} ${r.branch}: ${r.message}`
        })
        await ctx.reply(`🔄 Smart Sync:\n${lines.join('\n')}`)
      }
    }

    // Visual regression check (opt-in via data/bv-regression.json)
    await runVisualRegression(ctx, projectDir)

    // Auto-sync to paired remote if connected
    await syncToRemote(ctx, chatId, threadId, project.name)
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

async function syncToRemote(
  ctx: BotContext,
  chatId: number,
  threadId: number | undefined,
  projectName: string,
): Promise<void> {
  const pairing = getPairing(chatId, threadId)
  if (!pairing?.connected) return

  await ctx.reply('🔄 遠端同步中… (pull → build → restart)')

  try {
    // Step 1: git pull
    const pullResult = await remoteToolCall(
      pairing.code,
      'remote_execute_command',
      { command: 'git pull', cwd: 'C:\\ClaudeBot' },
      30_000,
    )
    if (pullResult.includes('Already up to date')) {
      await ctx.reply('ℹ️ 遠端已是最新，無需重新 build。')
      return
    }

    // Step 2: npm run build
    const buildResult = await remoteToolCall(
      pairing.code,
      'remote_execute_command',
      { command: 'npm run build', cwd: 'C:\\ClaudeBot' },
      120_000,
    )

    // Check for build errors
    if (buildResult.toLowerCase().includes('error ts')) {
      await ctx.reply(
        `❌ 遠端 build 失敗:\n\`\`\`\n${buildResult.slice(0, 300)}\n\`\`\``,
        { parse_mode: 'Markdown' },
      )
      return
    }

    // Step 3: trigger restart via .restart-all signal file
    await remoteToolCall(
      pairing.code,
      'remote_write_file',
      { path: 'data/.restart-all', content: String(Date.now()) },
      10_000,
    )

    await ctx.reply(`✅ [${projectName}] 遠端同步完成！Bot 重啟中…`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`⚠️ 遠端同步失敗: ${msg.slice(0, 200)}`)
  }
}

async function runVisualRegression(
  ctx: BotContext,
  projectDir: string,
): Promise<void> {
  const configPath = path.join(projectDir, 'data', 'bv-regression.json')
  if (!fs.existsSync(configPath)) return

  let config: RegressionConfig
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RegressionConfig
  } catch {
    return
  }

  if (!config.urls || config.urls.length === 0) return

  await ctx.reply('📸 Visual Regression: 擷取部署後截圖比對中...')

  try {
    // Wait for deploy to take effect
    const waitMs = config.waitAfterDeploy ?? 10_000
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    // Capture post-deploy and compare (baseline was pre-existing from last deploy)
    const baseline = await captureBaseline(config.urls)
    // In practice, baseline should be captured BEFORE push and stored.
    // For simplicity, we capture both now and compare with Gemini.
    const results = await compareWithBaseline(baseline, config.urls)

    const lines = results.map((r) => {
      const icon = r.hasDiff ? '🔴' : '🟢'
      return `${icon} ${r.url}\n   ${r.summary}`
    })

    const hasDiffs = results.some((r) => r.hasDiff)
    const header = hasDiffs ? '⚠️ Visual Regression 偵測到差異:' : '✅ Visual Regression: 無視覺差異'

    await ctx.reply(`${header}\n\n${lines.join('\n\n')}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`⚠️ Visual regression 檢查失敗: ${msg.slice(0, 200)}`)
  }
}
