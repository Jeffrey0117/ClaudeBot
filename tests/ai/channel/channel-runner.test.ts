import { describe, it, expect } from 'vitest'
import { __setManagerForTest, channelInterrupt, isChannelRunning } from '../../../src/ai/channel/channel-runner.js'
import { ChannelSessionManager } from '../../../src/ai/channel/session-manager.js'
import type { SessionBackend } from '../../../src/ai/channel/types.js'

function busyBackend(): SessionBackend {
  let busy = false
  return {
    start: async () => {},
    send: async () => { busy = true },
    interrupt: async () => { busy = false },
    stop: async () => {},
    isBusy: () => busy,
  }
}

describe('channelRunner routing helpers', () => {
  it('reports not running for an unknown project', () => {
    __setManagerForTest(new ChannelSessionManager(busyBackend))
    expect(isChannelRunning('/none')).toBe(false)
  })

  it('interrupts a busy session', async () => {
    const mgr = new ChannelSessionManager(busyBackend)
    __setManagerForTest(mgr)
    void mgr.runTurn('/p', { cwd: '/p', model: 'sonnet', systemPrompt: '', mcpConfigPaths: [] }, 'fp', 'x', () => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(isChannelRunning('/p')).toBe(true)
    expect(channelInterrupt('/p')).toBe(true)
  })
})
