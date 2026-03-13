import { execFileSync } from 'node:child_process'

export interface AutoCommitResult {
  readonly committed: boolean
  readonly pushed: boolean
  readonly commitMessage: string
  readonly filesChanged: number
  readonly pushError?: string
}

function isGitRepo(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return out.trim() === 'true'
  } catch {
    return false
  }
}

function getChangedFiles(cwd: string): string[] {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  if (!status) return []
  return status.split('\n').filter(Boolean)
}

function hasRemote(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['remote'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim()
    return out.length > 0
  } catch {
    return false
  }
}

function buildCommitMessage(_userPrompt: string): string {
  const now = new Date()
  const ts = now.toISOString().slice(0, 16).replace('T', ' ')
  return `bot: auto-sync ${ts}`
}

export function autoCommitAndPush(
  projectPath: string,
  userPrompt: string,
): AutoCommitResult | null {
  if (!isGitRepo(projectPath)) return null

  const changed = getChangedFiles(projectPath)
  if (changed.length === 0) return null

  const commitMessage = buildCommitMessage(userPrompt)

  // Use 'git add -u' (tracked files only) + 'git add .' (respects .gitignore)
  // instead of 'git add -A' to avoid staging secrets or junk files
  execFileSync('git', ['add', '.'], {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  execFileSync('git', ['commit', '-m', commitMessage], {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let pushed = false
  let pushError: string | undefined

  if (hasRemote(projectPath)) {
    try {
      execFileSync('git', ['push'], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      })
      pushed = true
    } catch (err) {
      pushError = err instanceof Error ? err.message : String(err)
    }
  }

  return { committed: true, pushed, commitMessage, filesChanged: changed.length, pushError }
}
