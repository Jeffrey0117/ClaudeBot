/**
 * Auto-sync worktree branch with master on bot startup.
 *
 * When WORKTREE_BRANCH is set, the bot runs in a worktree directory.
 * Master may have received fixes (CLAUDE.md, system-prompt, etc.) that
 * this worktree branch hasn't picked up. This module merges master into
 * the worktree branch at startup to stay current.
 */

import { env } from '../config/env.js'
import { syncFromMain, ensureWorktree, isGitRepo } from './worktree.js'

export function syncWorktreeOnStartup(): void {
  const branch = env.WORKTREE_BRANCH
  if (!branch) return

  const mainRepo = process.cwd()
  if (!isGitRepo(mainRepo)) return

  try {
    const wtPath = ensureWorktree(mainRepo, branch)
    const result = syncFromMain(wtPath)

    if (result.success) {
      console.log(`[worktree-sync] ${branch}: synced with master — ${result.message}`)
    } else {
      console.error(`[worktree-sync] ${branch}: sync failed — ${result.message}`)
      if (result.conflicts?.length) {
        console.error(`[worktree-sync] conflicts: ${result.conflicts.join(', ')}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[worktree-sync] ${branch}: error — ${msg}`)
  }
}
