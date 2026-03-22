import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scanProjects } from '../../config/projects.js'

export interface CommitInfo {
  readonly hash: string
  readonly date: string       // ISO timestamp
  readonly timestamp: number
  readonly message: string
  readonly insertions: number
  readonly deletions: number
  readonly project: string
}

export interface GitSummary {
  readonly totalCommits: number
  readonly totalInsertions: number
  readonly totalDeletions: number
  readonly projects: readonly { name: string; commits: number; insertions: number; deletions: number }[]
  readonly hourDistribution: readonly number[]  // 24 slots
  readonly dailyCommits: readonly { date: string; count: number }[]
  readonly commits: readonly CommitInfo[]
}

function runGit(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Quick mtime check: skip repos where git reflog hasn't been touched since sinceDate.
 * Filesystem stat only — no process spawn overhead.
 */
function hasRecentGitActivity(gitDir: string, sinceMs: number): boolean {
  try {
    // .git/logs/HEAD is updated on every commit, merge, checkout
    const headLog = join(gitDir, 'logs', 'HEAD')
    if (existsSync(headLog) && statSync(headLog).mtimeMs >= sinceMs) return true
    // Fallback: check packed-refs (updated on fetch/gc)
    const packedRefs = join(gitDir, 'packed-refs')
    if (existsSync(packedRefs) && statSync(packedRefs).mtimeMs >= sinceMs) return true
    return false
  } catch {
    return true // on error, don't skip — let git log handle it
  }
}

/** Cache: key = "sinceDate|untilDate", 30s TTL to avoid repeated scans across current+delta */
let gitCache: { key: string; data: GitSummary; ts: number } | null = null
const GIT_CACHE_TTL_MS = 30_000

/**
 * Get the canonical git dir for a project path.
 * Worktrees share the same git dir as the main repo, so this deduplicates them.
 */
function getGitDir(dirPath: string): string | null {
  // Check if .git exists
  const dotGit = join(dirPath, '.git')
  if (!existsSync(dotGit)) return null

  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) {
      // Normal repo — .git is a directory
      return resolve(dotGit)
    }
    // Worktree — .git is a file containing "gitdir: /path/to/main/.git/worktrees/xxx"
    // Use git rev-parse to get the common dir
    const commonDir = runGit(dirPath, ['rev-parse', '--git-common-dir'])
    return commonDir ? resolve(dirPath, commonDir) : null
  } catch {
    return null
  }
}

/** Normalize bare YYYY-MM-DD to explicit midnight so git doesn't misinterpret */
function normSince(d: string): string { return d.includes('T') ? d : `${d}T00:00:00` }
function normUntil(d: string): string { return d.includes('T') ? d : `${d}T23:59:59` }

/** Local YYYY-MM-DD from epoch ms (avoids UTC shift from toISOString) */
function localDateStr(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Scan git logs across all projects for a given time range.
 * Deduplicates worktrees (same repo scanned once) and commits (by hash).
 */
export function scanGitActivity(sinceDate: string, untilDate?: string): GitSummary {
  const cacheKey = `${sinceDate}|${untilDate ?? ''}`
  if (gitCache && gitCache.key === cacheKey && Date.now() - gitCache.ts < GIT_CACHE_TTL_MS) {
    return gitCache.data
  }

  const projects = scanProjects()
  const allCommits: CommitInfo[] = []
  const seenGitDirs = new Set<string>()
  const seenHashes = new Set<string>()
  const sinceNorm = normSince(sinceDate)
  const sinceMs = new Date(sinceNorm).getTime()

  const untilArgs = untilDate ? ['--until=' + normUntil(untilDate)] : []

  for (const project of projects) {
    // Skip backup directories — they duplicate the original repo's commits
    if (project.name.endsWith('.bak')) continue

    const gitDir = getGitDir(project.path)
    if (!gitDir) continue

    // Skip if we already scanned this git repo (worktree dedup)
    if (seenGitDirs.has(gitDir)) continue
    seenGitDirs.add(gitDir)

    // Fast mtime check: skip repos with no git activity since the range start
    if (!hasRecentGitActivity(gitDir, sinceMs)) continue

    // Use HEAD only (no --all), --no-merges for clean counts
    const log = runGit(
      project.path,
      ['log', '--no-merges', '--since=' + sinceNorm, ...untilArgs, '--pretty=format:%H|%aI|%s', '--shortstat'],
    )

    if (!log) continue

    const lines = log.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i].trim()
      if (!line || !line.includes('|')) {
        i++
        continue
      }

      const [hash, date, ...msgParts] = line.split('|')
      const message = msgParts.join('|')
      const timestamp = new Date(date).getTime()

      // Dedup by commit hash (same commit from forks/mirrors/clones)
      if (seenHashes.has(hash)) {
        i++
        // Still need to skip stat line if present
        if (i < lines.length && lines[i].trim().match(/\d+ (insertion|deletion)/)) i++
        continue
      }
      seenHashes.add(hash)

      // Next line(s) might be the stat line
      let insertions = 0
      let deletions = 0
      if (i + 1 < lines.length) {
        const statLine = lines[i + 1].trim()
        const insMatch = statLine.match(/(\d+) insertion/)
        const delMatch = statLine.match(/(\d+) deletion/)
        if (insMatch) insertions = parseInt(insMatch[1], 10)
        if (delMatch) deletions = parseInt(delMatch[1], 10)
        if (insMatch || delMatch) i++ // skip stat line
      }

      allCommits.push({
        hash,
        date,
        timestamp,
        message,
        insertions,
        deletions,
        project: project.name,
      })

      i++
    }
  }

  // Sort by timestamp
  allCommits.sort((a, b) => a.timestamp - b.timestamp)

  // Aggregate per project
  const projectMap = new Map<string, { commits: number; insertions: number; deletions: number }>()
  for (const c of allCommits) {
    const existing = projectMap.get(c.project) ?? { commits: 0, insertions: 0, deletions: 0 }
    projectMap.set(c.project, {
      commits: existing.commits + 1,
      insertions: existing.insertions + c.insertions,
      deletions: existing.deletions + c.deletions,
    })
  }

  // Hour distribution (24 slots)
  const hourDist = new Array(24).fill(0) as number[]
  for (const c of allCommits) {
    const hour = new Date(c.timestamp).getHours()
    hourDist[hour]++
  }

  // Daily commits
  const dailyMap = new Map<string, number>()
  for (const c of allCommits) {
    const day = localDateStr(c.timestamp)
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + 1)
  }

  const projectStats = [...projectMap.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.commits - a.commits)

  const result: GitSummary = {
    totalCommits: allCommits.length,
    totalInsertions: allCommits.reduce((s, c) => s + c.insertions, 0),
    totalDeletions: allCommits.reduce((s, c) => s + c.deletions, 0),
    projects: projectStats,
    hourDistribution: hourDist,
    dailyCommits: [...dailyMap.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    commits: allCommits,
  }

  gitCache = { key: cacheKey, data: result, ts: Date.now() }
  return result
}
