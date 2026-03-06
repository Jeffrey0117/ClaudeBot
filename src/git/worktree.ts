/**
 * Git worktree manager — enables multiple bot instances to work
 * on the same project simultaneously via isolated branches.
 *
 * Each bot with WORKTREE_BRANCH set gets its own worktree directory:
 *   C:\...\ClaudeBot  (master)
 *   C:\...\ClaudeBot--bot1  (worktree for bot1 branch)
 *   C:\...\ClaudeBot--bot5  (worktree for bot5 branch)
 *
 * Queue/lock/session systems automatically isolate because they
 * key on projectPath, which differs per worktree.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const GIT_TIMEOUT_MS = 30_000

interface WorktreeInfo {
  readonly worktreePath: string
  readonly branch: string
  readonly head: string
}

type MergeStrategy = 'clean' | 'smart' | 'conflict' | 'typecheck-fail'

interface MergeResult {
  readonly success: boolean
  readonly message: string
  readonly strategy?: MergeStrategy
  readonly conflicts?: readonly string[]
}

// --- Git helpers ---

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  }).trim()
}

/**
 * Compute the worktree directory path for a given project + branch.
 * Example: C:\code\ClaudeBot + "bot1" → C:\code\ClaudeBot--bot1
 */
export function worktreePath(projectPath: string, branch: string): string {
  const parent = dirname(projectPath)
  const name = basename(projectPath)
  return join(parent, `${name}--${branch}`)
}

/**
 * Check if a project directory is a git repository.
 */
export function isGitRepo(projectPath: string): boolean {
  try {
    git(['rev-parse', '--is-inside-work-tree'], projectPath)
    return true
  } catch {
    return false
  }
}

/**
 * List all worktrees for a git repository.
 */
export function listWorktrees(projectPath: string): readonly WorktreeInfo[] {
  try {
    const raw = git(['worktree', 'list', '--porcelain'], projectPath)
    if (!raw) return []

    const entries: WorktreeInfo[] = []
    let current: Partial<WorktreeInfo> = {}

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.worktreePath) {
          entries.push(current as WorktreeInfo)
        }
        current = { worktreePath: line.slice(9) }
      } else if (line.startsWith('HEAD ')) {
        current = { ...current, head: line.slice(5) }
      } else if (line.startsWith('branch ')) {
        // "branch refs/heads/bot1" → "bot1"
        current = { ...current, branch: line.slice(7).replace('refs/heads/', '') }
      }
    }

    if (current.worktreePath) {
      entries.push(current as WorktreeInfo)
    }

    return entries
  } catch {
    return []
  }
}

/**
 * Find an existing worktree for a specific branch.
 */
export function findWorktree(
  projectPath: string,
  branch: string,
): WorktreeInfo | null {
  const trees = listWorktrees(projectPath)
  return trees.find((t) => t.branch === branch) ?? null
}

/**
 * Ensure a worktree exists for the given branch.
 * Creates the branch + worktree if they don't exist yet.
 * Returns the worktree directory path.
 */
export function ensureWorktree(
  projectPath: string,
  branch: string,
): string {
  const targetPath = worktreePath(projectPath, branch)

  // Already exists and is registered?
  const existing = findWorktree(projectPath, branch)
  if (existing && existsSync(existing.worktreePath)) {
    return existing.worktreePath
  }

  // Clean up stale worktree reference if directory was deleted
  if (existing && !existsSync(existing.worktreePath)) {
    try {
      git(['worktree', 'remove', existing.worktreePath, '--force'], projectPath)
    } catch {
      // prune will handle it
      git(['worktree', 'prune'], projectPath)
    }
  }

  // Check if branch exists
  const branchExists = branchExistsLocally(projectPath, branch)

  if (branchExists) {
    git(['worktree', 'add', targetPath, branch], projectPath)
  } else {
    // Create new branch from current HEAD
    git(['worktree', 'add', '-b', branch, targetPath], projectPath)
  }

  return targetPath
}

/**
 * Check if a local branch exists.
 */
function branchExistsLocally(projectPath: string, branch: string): boolean {
  try {
    git(['rev-parse', '--verify', `refs/heads/${branch}`], projectPath)
    return true
  } catch {
    return false
  }
}

/**
 * Get the current branch name in a worktree.
 */
export function currentBranch(worktreeDir: string): string {
  return git(['branch', '--show-current'], worktreeDir)
}

/**
 * Smart Auto-Merge: sync worktree branch with the main branch.
 *
 * Flow:
 * 1. Dry-run check — is there anything to merge?
 * 2. git merge --no-commit — try merge without committing
 *    - No conflicts → proceed to step 3
 *    - Conflicts → abort + report
 * 3. TypeScript check (tsc --noEmit) — catch semantic conflicts
 *    - Pass → commit the merge
 *    - Fail → rollback + report
 */
export function syncFromMain(
  worktreeDir: string,
  mainBranch = 'master',
): MergeResult {
  // Step 0a: Clean up stale merge state (e.g. from a prior failed commit)
  try {
    git(['rev-parse', 'MERGE_HEAD'], worktreeDir)
    // MERGE_HEAD exists → abort the stale merge before proceeding
    try { git(['merge', '--abort'], worktreeDir) } catch { /* ignore */ }
  } catch {
    // No MERGE_HEAD — normal state
  }

  // Step 0b: Check if there's anything to merge
  try {
    const mergeBase = git(['merge-base', 'HEAD', mainBranch], worktreeDir)
    const mainHead = git(['rev-parse', mainBranch], worktreeDir)
    if (mergeBase === mainHead) {
      return { success: true, message: 'Already up to date', strategy: 'clean' }
    }
  } catch {
    // Can't determine merge-base, proceed anyway
  }

  // Step 1: Try merge --no-commit (dry run that stages the result)
  try {
    git(['merge', mainBranch, '--no-commit', '--no-ff'], worktreeDir)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)

    if (msg.includes('CONFLICT') || msg.includes('Automatic merge failed')) {
      const conflictFiles = parseConflictFiles(worktreeDir)
      try { git(['merge', '--abort'], worktreeDir) } catch { /* ignore */ }
      return {
        success: false,
        message: `合併衝突 (${conflictFiles.length} 個檔案)`,
        strategy: 'conflict',
        conflicts: conflictFiles,
      }
    }

    // Unknown error — abort if merge in progress
    try { git(['merge', '--abort'], worktreeDir) } catch { /* ignore */ }
    return { success: false, message: msg }
  }

  // Step 2: Merge succeeded without conflicts — run tsc check
  const tscResult = runTypeCheck(worktreeDir)

  if (!tscResult.pass) {
    // TypeScript failed — rollback the merge
    try { git(['merge', '--abort'], worktreeDir) } catch { /* ignore */ }
    return {
      success: false,
      message: `tsc 語意衝突:\n${tscResult.errors.slice(0, 3).join('\n')}`,
      strategy: 'typecheck-fail',
    }
  }

  // Step 3: All good — commit the merge
  try {
    git(['commit', '--no-edit', '--no-verify'], worktreeDir)
    return {
      success: true,
      message: 'smart-merged + tsc ✓',
      strategy: 'smart',
    }
  } catch (error) {
    // Commit failed (shouldn't happen, but be safe)
    try { git(['merge', '--abort'], worktreeDir) } catch { /* ignore */ }
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, message: msg }
  }
}

/**
 * Merge worktree branch back into the main branch.
 * Operates from the MAIN repo directory (not the worktree).
 */
export function mergeToMain(
  projectPath: string,
  branch: string,
  mainBranch = 'master',
): MergeResult {
  try {
    // Ensure we're on main branch in the main worktree
    const current = currentBranch(projectPath)
    if (current !== mainBranch) {
      git(['checkout', mainBranch], projectPath)
    }

    const result = git(
      ['merge', branch, '--no-edit', '--no-ff'],
      projectPath,
    )

    return { success: true, message: result || `Merged ${branch} into ${mainBranch}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)

    if (msg.includes('CONFLICT') || msg.includes('Automatic merge failed')) {
      const conflictFiles = parseConflictFiles(projectPath)
      try {
        git(['merge', '--abort'], projectPath)
      } catch { /* ignore */ }
      return {
        success: false,
        message: `合併衝突 (${branch} → ${mainBranch})`,
        conflicts: conflictFiles,
      }
    }

    return { success: false, message: msg }
  }
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export function removeWorktree(
  projectPath: string,
  branch: string,
  deleteBranch = false,
): void {
  const tree = findWorktree(projectPath, branch)
  if (tree) {
    try {
      git(['worktree', 'remove', tree.worktreePath, '--force'], projectPath)
    } catch {
      git(['worktree', 'prune'], projectPath)
    }
  }

  if (deleteBranch) {
    try {
      git(['branch', '-d', branch], projectPath)
    } catch {
      // Branch may not exist or has unmerged changes
    }
  }
}

/**
 * Check if a directory is inside a git worktree (not the main working tree).
 */
export function isWorktree(dir: string): boolean {
  try {
    const gitDir = git(['rev-parse', '--git-dir'], dir)
    // Worktrees have .git file pointing to main repo's .git/worktrees/<name>
    // Main repo has .git as a directory
    return gitDir.includes('worktrees')
  } catch {
    return false
  }
}

/**
 * Get the main repository path from a worktree directory.
 */
export function mainRepoPath(worktreeDir: string): string | null {
  try {
    const commonDir = git(['rev-parse', '--git-common-dir'], worktreeDir)
    // commonDir is like "C:/code/ClaudeBot/.git" — parent is the repo
    if (commonDir.endsWith('.git') || commonDir.endsWith('.git/')) {
      return dirname(commonDir.replace(/[/\\]$/, ''))
    }
    return dirname(commonDir)
  } catch {
    return null
  }
}

// --- TypeScript check ---

interface TscResult {
  readonly pass: boolean
  readonly errors: readonly string[]
}

function runTypeCheck(cwd: string): TscResult {
  try {
    // Find the tsconfig by walking up from worktree to find the main repo's config
    const mainDir = mainRepoPath(cwd) ?? cwd
    const tsconfigPath = join(mainDir, 'tsconfig.json')

    if (!existsSync(tsconfigPath)) {
      // No tsconfig → skip type check, assume pass
      return { pass: true, errors: [] }
    }

    // Run tsc --noEmit from the worktree dir
    // Use the main repo's node_modules/.bin/tsc
    const tscBin = join(mainDir, 'node_modules', '.bin', 'tsc')
    const tscCmd = existsSync(tscBin) || existsSync(tscBin + '.cmd') ? tscBin : 'npx tsc'

    execFileSync(
      tscCmd.includes('npx') ? 'npx' : tscBin,
      tscCmd.includes('npx') ? ['tsc', '--noEmit', '-p', tsconfigPath] : ['--noEmit', '-p', tsconfigPath],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 60_000,
        windowsHide: true,
        shell: true,
      },
    )
    return { pass: true, errors: [] }
  } catch (error) {
    const output = error instanceof Error
      ? (error as Error & { stdout?: string; stderr?: string }).stdout ?? (error as Error & { stderr?: string }).stderr ?? error.message
      : String(error)

    // Extract TS error lines (e.g. "src/foo.ts(10,5): error TS2345: ...")
    const errorLines = output.split('\n')
      .filter((line: string) => line.includes('error TS'))
      .map((line: string) => line.trim())

    return { pass: false, errors: errorLines.length > 0 ? errorLines : [output.slice(0, 300)] }
  }
}

// --- Sync all worktrees ---

export interface WorktreeSyncResult {
  readonly branch: string
  readonly success: boolean
  readonly message: string
  readonly strategy?: MergeStrategy
}

/**
 * Sync ALL worktrees with master.
 * Skips the master worktree and the source branch (the one that just deployed).
 * Returns a summary of each sync result.
 */
export function syncAllWorktrees(
  projectPath: string,
  mainBranch = 'master',
  skipBranch?: string,
): readonly WorktreeSyncResult[] {
  const trees = listWorktrees(projectPath)
  const results: WorktreeSyncResult[] = []

  for (const tree of trees) {
    // Skip master and the branch that just deployed
    if (tree.branch === mainBranch) continue
    if (skipBranch && tree.branch === skipBranch) continue
    if (!existsSync(tree.worktreePath)) continue

    const result = syncFromMain(tree.worktreePath, mainBranch)
    results.push({
      branch: tree.branch,
      success: result.success,
      strategy: result.strategy,
      message: result.success
        ? result.strategy === 'clean' ? 'up to date' : 'smart-merged'
        : result.conflicts?.length
          ? `conflict: ${result.conflicts.join(', ')}`
          : result.message,
    })
  }

  return results
}

// --- Internal helpers ---

function parseConflictFiles(cwd: string): readonly string[] {
  try {
    const raw = git(['diff', '--name-only', '--diff-filter=U'], cwd)
    return raw ? raw.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}
