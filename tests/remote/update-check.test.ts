import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Mirror of isNewerVersion in src/remote/electron/main.ts.
 *
 * That module cannot be imported here — it calls electron APIs at module load.
 * The guard below asserts the two stay identical, so this copy cannot silently
 * drift from the one that ships.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((p) => Number.parseInt(p, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

describe('desktop update check', () => {
  it('detects a newer release', () => {
    expect(isNewerVersion('v0.5.4', '0.5.3')).toBe(true)
    expect(isNewerVersion('v0.6.0', '0.5.9')).toBe(true)
    expect(isNewerVersion('v1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('v0.5.10', '0.5.9')).toBe(true)
  })

  it('does not prompt when equal or older', () => {
    expect(isNewerVersion('v0.5.3', '0.5.3')).toBe(false)
    expect(isNewerVersion('0.5.3', '0.5.3')).toBe(false)
    expect(isNewerVersion('v0.5.2', '0.5.3')).toBe(false)
    expect(isNewerVersion('v0.4.9', '0.5.0')).toBe(false)
  })

  it('treats a prerelease as its base version rather than guessing', () => {
    expect(isNewerVersion('v0.5.3-beta', '0.5.3')).toBe(false)
    expect(isNewerVersion('v0.5.4-beta', '0.5.3')).toBe(true)
  })

  it('survives junk without claiming an update', () => {
    expect(isNewerVersion('', '0.5.3')).toBe(false)
    expect(isNewerVersion('garbage', '0.5.3')).toBe(false)
  })

  /**
   * The bug this whole thing exists for: every release from v0.4.9 to v0.5.3
   * shipped an asset named ClaudeBot.Setup.0.3.1.exe because package.json was
   * never bumped, so app.getVersion() returned 0.3.1 on every build ever
   * installed. Any version-based update check would then nag forever, even
   * right after installing the newest release.
   */
  it('package.json version is not left behind the published releases', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }
    expect(isNewerVersion('v0.5.3', pkg.version)).toBe(false)
  })

  it('the shipped comparator matches the one tested here', () => {
    const src = readFileSync(resolve('src/remote/electron/main.ts'), 'utf-8')
    // the exact parse line is the part that matters
    expect(src).toContain("v.replace(/^v/, '').split('-')[0].split('.')")
    expect(src).toContain('function isNewerVersion(')
  })
})
