import { describe, it, expect } from 'vitest'
import { isDangerousCmd, registerPendingCmd, takePendingCmd } from '../../src/bot/cmd-guard.js'

describe('cmd-guard', () => {
  it('flags machine-mutating commands as dangerous', () => {
    for (const name of ['restart', 'deploy', 'rpower', 'rx', 'js', 'selfupdate', 'land']) {
      expect(isDangerousCmd(name)).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isDangerousCmd('RESTART')).toBe(true)
    expect(isDangerousCmd('RPower')).toBe(true)
  })

  it('leaves read-only commands alone', () => {
    for (const name of ['status', 'ctx', 'todos', 'help', 'last', 'projects']) {
      expect(isDangerousCmd(name)).toBe(false)
    }
  })

  it('round-trips a pending command for the same chat', () => {
    const id = registerPendingCmd('restart', '/restart all', 123)
    const cmd = takePendingCmd(id, 123)
    expect(cmd).not.toBeNull()
    expect(cmd?.command).toBe('/restart all')
  })

  it('rejects a chatId mismatch (another chat cannot confirm your command)', () => {
    const id = registerPendingCmd('deploy', '/deploy makee', 123)
    expect(takePendingCmd(id, 999)).toBeNull()
    // and the original owner can still take it
    expect(takePendingCmd(id, 123)).not.toBeNull()
  })

  it('is single-use', () => {
    const id = registerPendingCmd('rx', '/rx pc dir', 123)
    expect(takePendingCmd(id, 123)).not.toBeNull()
    expect(takePendingCmd(id, 123)).toBeNull()
  })

  it('returns null for unknown ids', () => {
    expect(takePendingCmd('nope', 123)).toBeNull()
  })
})
