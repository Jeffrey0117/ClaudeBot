import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProjectInfo } from '../types/index.js'
import { env } from './env.js'
import { ensureWorktree, isGitRepo } from '../git/worktree.js'

export function getBaseDirs(): readonly string[] {
  return env.PROJECTS_BASE_DIR.map((d) => resolve(d))
}

const SCAN_TTL_MS = 5_000
let scanCache: readonly ProjectInfo[] | null = null
let scanCacheTime = 0

/** Directories to skip when scanning (system/non-project folders) */
const SKIP_DIRS = new Set([
  'program files',
  'program files (x86)',
  'windows',
  'users',
  'perflogs',
  'recovery',
  '$recycle.bin',
  'system volume information',
  'documents and settings',
  'msys64',
  'mingw64',
  'intel',
  'amd',
  'nvidia',
  'drivers',
  'boot',
  'inetpub',
])

export function scanProjects(): readonly ProjectInfo[] {
  const now = Date.now()
  if (scanCache && now - scanCacheTime < SCAN_TTL_MS) {
    return scanCache
  }

  const results: ProjectInfo[] = []

  for (const baseDir of getBaseDirs()) {
    try {
      const entries = readdirSync(baseDir)
      for (const entry of entries) {
        if (entry.startsWith('.') || SKIP_DIRS.has(entry.toLowerCase())) continue
        const fullPath = join(baseDir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            results.push({ name: entry, path: fullPath })
          }
        } catch {
          // skip inaccessible entries
        }
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to scan projects directory "${baseDir}": ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  scanCache = results
  scanCacheTime = now
  return results
}

/** Force cache invalidation (e.g. after mkdir) */
export function invalidateProjectCache(): void {
  scanCache = null
  scanCacheTime = 0
}

/**
 * Resolve a project to use a git worktree path when WORKTREE_BRANCH is set.
 * If the project is a git repo and the bot has a worktree branch configured,
 * the returned ProjectInfo will point to the worktree directory instead.
 * The `name` stays the same so the project identity is preserved.
 */
export function resolveWorktreePath(project: ProjectInfo): ProjectInfo {
  const branch = env.WORKTREE_BRANCH
  if (!branch) return project

  // WORKTREE_PROJECTS scoping: if set, only listed projects get worktree isolation.
  // Other projects stay on master (avoid pushing to botN branch by accident).
  const scoped = env.WORKTREE_PROJECTS
  if (scoped.length > 0) {
    const isListed = scoped.some(
      (name) => name.toLowerCase() === project.name.toLowerCase(),
    )
    if (!isListed) return project
  }

  if (!isGitRepo(project.path)) return project

  try {
    const wtPath = ensureWorktree(project.path, branch)
    return { ...project, path: wtPath }
  } catch {
    // Worktree creation failed — fall back to original path
    return project
  }
}

export function findProject(query: string): ProjectInfo | null {
  const projects = scanProjects()
  const q = query.toLowerCase().trim()

  // 1. Exact match
  const exact = projects.find((p) => p.name.toLowerCase() === q)
  if (exact) return resolveWorktreePath(exact)

  // 2. Path fragment match (e.g., "Desktop/code/weetube" or "C:\Users\...\weetube")
  const normalized = q.replace(/\\/g, '/')
  const byPath = projects.find((p) => p.path.replace(/\\/g, '/').toLowerCase().endsWith(normalized))
  if (byPath) return resolveWorktreePath(byPath)

  // 3. Starts-with match (e.g., "wee" → "weetube")
  const startsWith = projects.filter((p) => p.name.toLowerCase().startsWith(q))
  if (startsWith.length === 1) return resolveWorktreePath(startsWith[0])

  // 4. Contains match (e.g., "tube" → "weetube")
  const contains = projects.filter((p) => p.name.toLowerCase().includes(q))
  if (contains.length === 1) return resolveWorktreePath(contains[0])

  return null
}
