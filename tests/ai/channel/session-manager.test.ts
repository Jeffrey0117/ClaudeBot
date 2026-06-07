import { describe, it, expect } from 'vitest'
import { ChannelSessionManager } from '../../../src/ai/channel/session-manager.js'
import type { SessionBackend, SessionLaunchConfig, SessionEvent } from '../../../src/ai/channel/types.js'

function stubBackend() {
  const calls: string[] = []
  let busy = false
  const be: SessionBackend = {
    start: async (_c: SessionLaunchConfig) => { calls.push('start') },
    send: async (text, onEvent) => {
      busy = true
      calls.push(`send:${text}`)
      onEvent({ kind: 'text-delta', text: 'hi' } as SessionEvent)
      onEvent({ kind: 'result', result: { backend: 'channel', model: 'sonnet', sessionId: 's', costUsd: 0, durationMs: 1, cancelled: false, resultText: 'hi' } } as SessionEvent)
      busy = false
    },
    interrupt: async () => { calls.push('interrupt') },
    stop: async () => { calls.push('stop') },
    isBusy: () => busy,
  }
  return { be, calls }
}

const cfg = (over: Partial<SessionLaunchConfig> = {}): SessionLaunchConfig => ({ cwd: '/proj', model: 'sonnet', systemPrompt: '', mcpConfigPaths: [], ...over })

describe('ChannelSessionManager', () => {
  it('lazy-starts a session on first turn, reuses it on the second', async () => {
    const { be, calls } = stubBackend()
    const mgr = new ChannelSessionManager(() => be)
    const events: SessionEvent[] = []
    await mgr.runTurn('k1', cfg(), 'fp1', 'hello', (e) => events.push(e))
    await mgr.runTurn('k1', cfg(), 'fp1', 'again', (e) => events.push(e))
    expect(calls.filter((c) => c === 'start').length).toBe(1)
    expect(calls).toContain('send:hello')
    expect(calls).toContain('send:again')
    expect(events.some((e) => e.kind === 'result')).toBe(true)
  })

  it('restarts the session when the fingerprint changes', async () => {
    const { be, calls } = stubBackend()
    const mgr = new ChannelSessionManager(() => be)
    await mgr.runTurn('k1', cfg(), 'fp1', 'a', () => {})
    await mgr.runTurn('k1', cfg({ model: 'opus' }), 'fp2', 'b', () => {})
    expect(calls.filter((c) => c === 'start').length).toBe(2)
    expect(calls).toContain('stop')
  })

  it('interrupt keeps the session (no stop) and returns true', async () => {
    const { be, calls } = stubBackend()
    const mgr = new ChannelSessionManager(() => be)
    await mgr.runTurn('k1', cfg(), 'fp1', 'a', () => {})
    expect(mgr.interrupt('k1')).toBe(true)
    expect(calls).toContain('interrupt')
    expect(calls).not.toContain('stop')
  })

  it('interrupt returns false for an unknown key', () => {
    const { be } = stubBackend()
    const mgr = new ChannelSessionManager(() => be)
    expect(mgr.interrupt('nope')).toBe(false)
  })

  it('reports busy state and session existence', async () => {
    const { be } = stubBackend()
    const mgr = new ChannelSessionManager(() => be)
    expect(mgr.hasSession('k1')).toBe(false)
    await mgr.runTurn('k1', cfg(), 'fp1', 'a', () => {})
    expect(mgr.hasSession('k1')).toBe(true)
    expect(mgr.isBusy('k1')).toBe(false) // stub send() finished, so not busy
  })
})
