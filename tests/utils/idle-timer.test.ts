import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createIdleTimer } from '../../src/utils/idle-timer.js'
import { createLineStamper } from '../../src/utils/rotating-log.js'

describe('createIdleTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once after the idle period', () => {
    const onIdle = vi.fn()
    createIdleTimer(1000, onIdle).touch()
    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('each touch restarts the countdown', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(1000, onIdle)
    timer.touch()
    vi.advanceTimersByTime(800)
    timer.touch()
    vi.advanceTimersByTime(800)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('does nothing until touched, and cancel stops it', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(1000, onIdle)
    vi.advanceTimersByTime(5000)
    expect(onIdle).not.toHaveBeenCalled()
    timer.touch()
    timer.cancel()
    vi.advanceTimersByTime(5000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('is disabled when the period is zero', () => {
    const onIdle = vi.fn()
    createIdleTimer(0, onIdle).touch()
    vi.advanceTimersByTime(60_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('postpones while the caller says it is still busy', () => {
    const onIdle = vi.fn()
    let busy = true
    createIdleTimer(1000, onIdle, () => busy).touch()
    vi.advanceTimersByTime(3000)
    expect(onIdle).not.toHaveBeenCalled()
    busy = false
    vi.advanceTimersByTime(1000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})

describe('createLineStamper', () => {
  const at = (iso: string) => () => new Date(iso)

  it('puts the local date and time in front of each line', () => {
    const stamp = createLineStamper(at('2026-11-13T14:05:09'))
    expect(stamp('hello\n')).toBe('11-13 14:05:09 hello\n')
  })

  it('stamps every line of a multi-line chunk', () => {
    const stamp = createLineStamper(at('2026-01-02T03:04:05'))
    expect(stamp('a\nb\n')).toBe('01-02 03:04:05 a\n01-02 03:04:05 b\n')
  })

  it('does not stamp the middle of a line split across writes', () => {
    const stamp = createLineStamper(at('2026-01-02T03:04:05'))
    expect(stamp('par')).toBe('01-02 03:04:05 par')
    expect(stamp('tial\nnext\n')).toBe('tial\n01-02 03:04:05 next\n')
  })

  it('leaves empty lines unstamped', () => {
    const stamp = createLineStamper(at('2026-01-02T03:04:05'))
    expect(stamp('\nline\n')).toBe('\n01-02 03:04:05 line\n')
  })
})
