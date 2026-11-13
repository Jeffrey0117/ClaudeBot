import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Regression: git helpers ran execFileSync without stdio, so git's own
// "fatal: not a git repository" went straight to the bot's stderr every time a
// non-repo folder was probed — the launcher log collected it dozens of times.
// It has to be checked from a child process: the leak bypasses process.stderr.

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function runProbe(body: string): { stdout: string; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'quiet-git-'))
  const script = join(dir, 'probe.mts')
  writeFileSync(script, body, 'utf-8')
  const tsx = resolve('node_modules', 'tsx', 'dist', 'cli.mjs')
  const res = spawnSync(process.execPath, [tsx, script], {
    encoding: 'utf-8',
    env: { ...process.env, PROBE_DIR: dir },
    timeout: 60_000,
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const src = (rel: string): string => pathToFileURL(resolve('src', rel)).href

describe('git helpers on a folder that is not a repository', () => {
  it('isGitRepo answers false without leaking git errors to stderr', () => {
    const { stdout, stderr } = runProbe(`
      const { isGitRepo } = await import(${JSON.stringify(src('git/worktree.ts'))})
      console.log('result=' + isGitRepo(process.env.PROBE_DIR))
    `)
    expect(stdout).toContain('result=false')
    expect(stderr).not.toContain('not a git repository')
  }, 90_000)
})
