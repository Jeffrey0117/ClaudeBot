import { describe, it, expect } from 'vitest'
import {
  getSessionInfo,
  setAISessionId,
  clearAISession,
  consumeExpiryNotice,
  getAISessionId,
} from '../../src/ai/session-store.js'

// Unique path per test so module-singleton state can't bleed across cases.
let n = 0
const p = () => `/test/mem-${Date.now()}-${n++}`

describe('session-store getSessionInfo', () => {
  it('reports no session before anything is set', () => {
    const info = getSessionInfo('claude', p())
    expect(info.exists).toBe(false)
    expect(info.promptCount).toBe(0)
    expect(info.ageMs).toBe(0)
    expect(info.tokenFraction).toBe(0)
  })

  it('tracks existence, prompt count and age after set', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-1')
    let info = getSessionInfo('claude', path)
    expect(info.exists).toBe(true)
    expect(info.promptCount).toBe(1)
    expect(info.ageMs).toBeGreaterThanOrEqual(0)

    setAISessionId('claude', path, 'sid-1')
    info = getSessionInfo('claude', path)
    expect(info.promptCount).toBe(2)
  })

  it('clearAISession resets existence and prompt count', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-2')
    expect(getSessionInfo('claude', path).exists).toBe(true)
    clearAISession('claude', path)
    const info = getSessionInfo('claude', path)
    expect(info.exists).toBe(false)
    expect(info.promptCount).toBe(0)
  })

  it('getAISessionId returns the stored id', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-3')
    expect(getAISessionId('claude', path)).toBe('sid-3')
  })
})

describe('session-store consumeExpiryNotice', () => {
  it('returns false when no expiry happened', () => {
    expect(consumeExpiryNotice('claude', p())).toBe(false)
  })

  it('is false for a freshly-set, non-expired session', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-4')
    expect(consumeExpiryNotice('claude', path)).toBe(false)
  })
})
