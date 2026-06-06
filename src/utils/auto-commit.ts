import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isWorktree, mainRepoPath, mergeToMain } from '../git/worktree.js'

// Async git so a slow `git push` (network, up to 30s) never blocks the single
// bot event loop. A blocked loop froze the heartbeat and could trip the
// watchdog into a false SIGTERM mid-turn.
const execFileAsync = promisify(execFile)

export interface AutoCommitResult {
  readonly committed: boolean
  readonly pushed: boolean
  readonly commitMessage: string
  readonly filesChanged: number
  readonly pushError?: string
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      windowsHide: true,
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd, windowsHide: true })
  const status = stdout.trim()
  if (!status) return []
  return status.split('\n').filter(Boolean)
}

async function hasRemote(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], { cwd, windowsHide: true })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

function buildCommitMessage(_userPrompt: string): string {
  const now = new Date()
  const ts = now.toISOString().slice(0, 16).replace('T', ' ')
  return `bot: auto-sync ${ts}`
}

export async function autoCommitAndPush(
  projectPath: string,
  userPrompt: string,
): Promise<AutoCommitResult | null> {
  if (!(await isGitRepo(projectPath))) return null

  const changed = await getChangedFiles(projectPath)
  if (changed.length === 0) return null

  const commitMessage = buildCommitMessage(userPrompt)

  // 'git add .' respects .gitignore (avoids staging secrets/junk).
  await execFileAsync('git', ['add', '.'], { cwd: projectPath, windowsHide: true })
  await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: projectPath, windowsHide: true })

  let pushed = false
  let pushError: string | undefined

  if (await hasRemote(projectPath)) {
    let branch = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectPath, windowsHide: true,
      })
      branch = stdout.trim()
    } catch { /* ignore */ }

    if (branch === 'master' || branch === 'main') {
      try {
        await execFileAsync('git', ['push'], { cwd: projectPath, timeout: 30_000, windowsHide: true })
        pushed = true
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err)
      }
    } else if (branch && isWorktree(projectPath)) {
      // Auto-land: merge this worktree branch (bot1, bot2…) into master so bot
      // fixes reach master automatically — no manual /land needed, and "local"
      // sessions see the change. We push master (NOT the bot branch, which would
      // spam GitHub PR banners). On conflict the merge aborts safely and the
      // commit stays on the branch for a manual /land.
      const mainDir = mainRepoPath(projectPath)
      if (mainDir) {
        const merge = mergeToMain(mainDir, branch)
        if (merge.success) {
          try {
            await execFileAsync('git', ['push', 'origin', 'master'], {
              cwd: mainDir, timeout: 30_000, windowsHide: true,
            })
            pushed = true
          } catch (err) {
            pushError = err instanceof Error ? err.message : String(err)
          }
        } else {
          pushError = `auto-land 未完成（留在 ${branch}，可手動 /land）: ${merge.message}`
        }
      }
    }
  }

  return { committed: true, pushed, commitMessage, filesChanged: changed.length, pushError }
}
