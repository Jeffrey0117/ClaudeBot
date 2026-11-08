import { describe, it, expect } from 'vitest'
import { __setManagerForTest, channelInterrupt, isChannelRunning, channelRunner } from '../../../src/ai/channel/channel-runner.js'
import { ChannelSessionManager } from '../../../src/ai/channel/session-manager.js'
import type { SessionBackend } from '../../../src/ai/channel/types.js'
import { addPin, clearPins } from '../../../src/bot/context-pin-store.js'
import { setAISessionId, getAISessionId } from '../../../src/ai/session-store.js'
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

/**
 * A stored session id can outlive its conversation. A warm session ignores
 * resumeSessionId, so a dangling id sits unnoticed until the next cold start —
 * a bot restart. This backend had no recovery, so the raw "No conversation
 * found with session ID: ..." reached the user and every later turn failed the
 * same way, with no way out short of /new.
 */
describe('channelRunner stale-session recovery', () => {
  function scriptedManager(messages: readonly string[]) {
    const mgr = new ChannelSessionManager(busyBackend)
    const calls: Array<{ resume?: string }> = []
    let n = 0
    mgr.runTurn = async (_key, cfg, _fp, _prompt, onEvent) => {
      const i = n++
      calls.push({ resume: (cfg as { resumeSessionId?: string }).resumeSessionId })
      if (i < messages.length) {
        onEvent({ kind: 'error', message: messages[i] })
        return
      }
      onEvent({
        kind: 'result',
        result: {
          backend: 'channel',
          model: 'sonnet',
          sessionId: 'fresh-session-id',
          costUsd: 0,
          durationMs: 1,
          cancelled: false,
          resultText: 'ok',
        },
      })
    }
    return { mgr, calls }
  }

  function runWith(projectPath: string, mgr: ChannelSessionManager) {
    const seen = { errors: [] as string[], results: [] as string[], staleNotices: 0 }
    channelRunner.run({
      prompt: 'hello',
      projectPath,
      projectName: 'stale',
      model: 'sonnet',
      sessionId: null,
      imagePaths: [],
      onTextDelta: () => {},
      onToolUse: () => {},
      onResult: (r) => seen.results.push(r.sessionId),
      onError: (e) => seen.errors.push(e),
      onStaleRetry: () => { seen.staleNotices++ },
    })
    return seen
  }

  it('clears a dangling id, retries cold, and never shows the raw error', async () => {
    const projectPath = `C:/tmp/chan-stale-${Date.now()}`
    setAISessionId('channel', projectPath, 'dangling-id')

    const { mgr, calls } = scriptedManager([
      'No conversation found with session ID: dangling-id',
    ])
    __setManagerForTest(mgr)

    const seen = runWith(projectPath, mgr)
    await new Promise((r) => setTimeout(r, 20))

    expect(seen.errors).toEqual([])
    expect(seen.staleNotices).toBe(1)
    expect(seen.results).toEqual(['fresh-session-id'])

    // first attempt resumed, the retry did not
    expect(calls).toHaveLength(2)
    expect(calls[0].resume).toBe('dangling-id')
    expect(calls[1].resume).toBeUndefined()

    // the fresh id replaced the dangling one
    expect(getAISessionId('channel', projectPath)).toBe('fresh-session-id')
  })

  it('retries only once, then reports a genuine failure', async () => {
    const projectPath = `C:/tmp/chan-stale2-${Date.now()}`
    setAISessionId('channel', projectPath, 'dangling-id-2')

    const { mgr, calls } = scriptedManager([
      'No conversation found with session ID: dangling-id-2',
      'No conversation found with session ID: dangling-id-2',
    ])
    __setManagerForTest(mgr)

    const seen = runWith(projectPath, mgr)
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toHaveLength(2)
    expect(seen.staleNotices).toBe(1)
    expect(seen.errors).toHaveLength(1)
    expect(seen.results).toEqual([])
  })

  it('passes unrelated errors straight through', async () => {
    const projectPath = `C:/tmp/chan-other-${Date.now()}`
    setAISessionId('channel', projectPath, 'some-id')

    const { mgr, calls } = scriptedManager(['API rate limit exceeded'])
    __setManagerForTest(mgr)

    const seen = runWith(projectPath, mgr)
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toHaveLength(1)
    expect(seen.staleNotices).toBe(0)
    expect(seen.errors).toEqual(['API rate limit exceeded'])
    // a real error must not discard the stored session
    expect(getAISessionId('channel', projectPath)).toBe('some-id')
  })
})
