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
    }).trim()
    return out.length > 0
  } catch {
    return false
  }
}

function buildCommitMessage(userPrompt: string): string {
  const oneLine = userPrompt.replace(/\n/g, ' ').trim()
  const truncated = oneLine.length > 72
    ? oneLine.slice(0, 69) + '...'
    : oneLine
  return `bot: ${truncated}`
}

export function autoCommitAndPush(
  projectPath: string,
  userPrompt: string,
): AutoCommitResult | null {
  if (!isGitRepo(projectPath)) return null

  const changed = getChangedFiles(projectPath)
  if (changed.length === 0) return null

  const commitMessage = buildCommitMessage(userPrompt)

  execFileSync('git', ['add', '-A'], {
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
