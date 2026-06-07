/**
 * Unit tests for resolveChannelLaunch (local branch only).
 *
 * The REMOTE branch requires live pairing state (relay-server, virtual-chat-store,
 * etc.) — those are integration-level concerns and are not unit-tested here.
 * The contract is: no chatId  ⇒  always returns a local config.
 */
import { describe, it, expect } from 'vitest'
import { resolveChannelLaunch } from '../../../src/ai/channel/remote-launch.js'

describe('resolveChannelLaunch — local branch', () => {
  const projectPath = '/projects/myapp'
  const model = 'claude-sonnet-4-5'

  it('returns local config when no chatId is provided', () => {
    const { cfg, fingerprint } = resolveChannelLaunch({ projectPath, model })
    expect(cfg.cwd).toBe(projectPath)
    expect(cfg.mcpConfigPaths).toHaveLength(0)
    expect(cfg.disallowedTools).toBeUndefined()
    expect(cfg.cleanup).toBeUndefined()
    expect(cfg.model).toBe(model)
    expect(fingerprint).toBeTruthy()
    expect(fingerprint).toHaveLength(16) // sha256 sliced to 16 hex chars
  })

  it('fingerprint is stable for the same inputs (no chatId)', () => {
    const a = resolveChannelLaunch({ projectPath, model })
    const b = resolveChannelLaunch({ projectPath, model })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('fingerprint changes when model changes', () => {
    const a = resolveChannelLaunch({ projectPath, model: 'claude-sonnet-4-5' })
    const b = resolveChannelLaunch({ projectPath, model: 'claude-opus-4-5' })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('maxTurns is forwarded into cfg', () => {
    const { cfg } = resolveChannelLaunch({ projectPath, model, maxTurns: 5 })
    expect(cfg.maxTurns).toBe(5)
  })

  it('maxTurns is undefined when not provided', () => {
    const { cfg } = resolveChannelLaunch({ projectPath, model })
    expect(cfg.maxTurns).toBeUndefined()
  })
})
