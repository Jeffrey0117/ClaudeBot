import { describe, it, expect } from 'vitest'
import {
  getSessionInfo,
  setAISessionId,
  clearAISession,
  consumeExpiryNotice,
  getAISessionId,
  normalizeProjectKey,
} from '../../src/ai/session-store.js'

/** Backslash without a literal escape, so the intent stays unambiguous. */
const BS = String.fromCharCode(92)
const toWindowsStyle = (p: string): string => p.split('/').join(BS)

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

describe('session-store key normalization', () => {
  // `git worktree list --porcelain` reports C:/Users/... while path.resolve()
  // and join() produce C:\Users\... . claude-runner wrote the session id with
  // the resolved spelling and every reader looked it up with the git spelling,
  // so --resume never matched and each turn started a fresh conversation.
  it('finds a session stored under the other slash style', () => {
    const forward = `C:/Users/test/code/proj-${Date.now()}--bot1`
    const backslash = toWindowsStyle(forward)
    expect(backslash).not.toBe(forward)

    setAISessionId('claude', forward, 'sid-slash')
    expect(getAISessionId('claude', backslash)).toBe('sid-slash')
  })

  it('works in the other direction too (written resolved, read from git)', () => {
    const forward = `C:/Users/test/code/other-${Date.now()}--bot1`
    setAISessionId('claude', toWindowsStyle(forward), 'sid-rev')
    expect(getAISessionId('claude', forward)).toBe('sid-rev')
  })

  it('clears the same session regardless of spelling', () => {
    const forward = `C:/Users/test/code/clear-${Date.now()}--bot1`
    setAISessionId('claude', forward, 'sid-clear')
    clearAISession('claude', toWindowsStyle(forward))
    expect(getAISessionId('claude', forward)).toBeNull()
  })

  it('counts prompts on one session, not two', () => {
    const forward = `C:/Users/test/code/count-${Date.now()}--bot1`
    setAISessionId('claude', forward, 'sid-count')
    setAISessionId('claude', toWindowsStyle(forward), 'sid-count')
    expect(getSessionInfo('claude', forward).promptCount).toBe(2)
  })

  it('canonicalizes drive-letter case and a trailing separator', () => {
    expect(normalizeProjectKey('c:/Users/x/')).toBe('C:/Users/x')
    expect(normalizeProjectKey(toWindowsStyle('C:/Users/x'))).toBe('C:/Users/x')
  })

  it('leaves non-path keys such as remote:<label> untouched', () => {
    expect(normalizeProjectKey('remote:mybox')).toBe('remote:mybox')
  })

  it('keeps a bare drive root intact', () => {
    expect(normalizeProjectKey('C:/')).toBe('C:/')
  })
})
