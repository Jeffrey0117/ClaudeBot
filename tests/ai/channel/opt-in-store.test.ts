import { describe, it, expect, beforeEach } from 'vitest'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { setChannelEnabled, isChannelEnabled, __resetForTest } from '../../../src/ai/channel/opt-in-store.js'

const DATA = resolve('data/channel-opt-in.json')

describe('channel enable store (default-on for local)', () => {
  beforeEach(() => {
    try { rmSync(DATA) } catch { /* missing is fine */ }
    __resetForTest()
  })

  it('defaults to ON for a local project', () => {
    expect(isChannelEnabled('/proj/a')).toBe(true)
  })

  it('an explicit off disables a specific local project', () => {
    setChannelEnabled('/proj/a', false)
    expect(isChannelEnabled('/proj/a')).toBe(false)
    expect(isChannelEnabled('/proj/b')).toBe(true)
  })

  it('re-enabling clears the override (back to default-on)', () => {
    setChannelEnabled('/proj/a', false)
    setChannelEnabled('/proj/a', true)
    expect(isChannelEnabled('/proj/a')).toBe(true)
  })

  it('remote projects are disabled when CHANNEL_REMOTE is unset (default)', () => {
    // CHANNEL_REMOTE is not set in the test env — remote must stay off
    expect(isChannelEnabled('remote:mybox')).toBe(false)
    setChannelEnabled('remote:mybox', true) // store override cannot override the env gate
    expect(isChannelEnabled('remote:mybox')).toBe(false)
  })
})
