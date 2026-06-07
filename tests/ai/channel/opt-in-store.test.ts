import { describe, it, expect, beforeEach } from 'vitest'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { setChannelOptIn, isChannelOptIn, __resetForTest } from '../../../src/ai/channel/opt-in-store.js'

const DATA = resolve('data/channel-opt-in.json')

describe('channel opt-in store', () => {
  beforeEach(() => {
    try { rmSync(DATA) } catch { /* missing is fine */ }
    __resetForTest()
  })
  it('defaults to false', () => { expect(isChannelOptIn('/proj/a')).toBe(false) })
  it('persists an opt-in per project path', () => {
    setChannelOptIn('/proj/a', true)
    expect(isChannelOptIn('/proj/a')).toBe(true)
    expect(isChannelOptIn('/proj/b')).toBe(false)
  })
  it('can opt back out', () => {
    setChannelOptIn('/proj/a', true)
    setChannelOptIn('/proj/a', false)
    expect(isChannelOptIn('/proj/a')).toBe(false)
  })
})
