import { describe, it, expect } from 'vitest'
import { __setManagerForTest, channelInterrupt, isChannelRunning, channelRunner } from '../../../src/ai/channel/channel-runner.js'
import { ChannelSessionManager } from '../../../src/ai/channel/session-manager.js'
import type { SessionBackend } from '../../../src/ai/channel/types.js'
import { addPin, clearPins } from '../../../src/bot/context-pin-store.js'
import { addTodo } from '../../../src/bot/todo-store.js'

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

/**
 * The channel backend is the default for local projects, but it used to pass
 * opts.prompt straight through — so pins, @learn rules and todos were stored
 * and confirmed to the user, then never reached the model.
 */
describe('channelRunner memory injection', () => {
  function capturingManager(): { mgr: ChannelSessionManager; seen: () => string } {
    const mgr = new ChannelSessionManager(busyBackend)
    let seen = ''
    const original = mgr.runTurn.bind(mgr)
    mgr.runTurn = async (key, cfg, fp, prompt, onEvent) => {
      seen = prompt
      return original(key, cfg, fp, prompt, onEvent)
    }
    return { mgr, seen: () => seen }
  }

  function run(projectPath: string, prompt: string): void {
    channelRunner.run({
      prompt,
      projectPath,
      projectName: 'memtest',
      model: 'sonnet',
      sessionId: null,
      imagePaths: [],
      onTextDelta: () => {},
      onToolUse: () => {},
      onResult: () => {},
      onError: () => {},
    })
  }

  it('puts pinned context and todos in front of the user prompt', async () => {
    const projectPath = `C:/tmp/chan-mem-${Date.now()}`
    clearPins(projectPath)
    addPin(projectPath, 'PIN-MARKER-7391')
    addTodo(projectPath, 'TODO-MARKER-7391')

    const { mgr, seen } = capturingManager()
    __setManagerForTest(mgr)
    run(projectPath, '請幫我看一下這段程式')
    await new Promise((r) => setTimeout(r, 10))

    const prompt = seen()
    expect(prompt).toContain('PIN-MARKER-7391')
    expect(prompt).toContain('TODO-MARKER-7391')
    expect(prompt).toContain('memtest')
    // the user's own message stays last
    expect(prompt.trimEnd().endsWith('請幫我看一下這段程式')).toBe(true)
    clearPins(projectPath)
  })

  it('still sends the bare prompt when there is nothing stored', async () => {
    const projectPath = `C:/tmp/chan-empty-${Date.now()}`
    const { mgr, seen } = capturingManager()
    __setManagerForTest(mgr)
    run(projectPath, '一段比較長的訊息，不該觸發摘要注入，只要原文就好')
    await new Promise((r) => setTimeout(r, 10))

    expect(seen()).toContain('一段比較長的訊息')
    expect(seen()).not.toContain('PIN-MARKER-7391')
  })
})
