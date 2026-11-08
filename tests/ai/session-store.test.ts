import { describe, it, expect } from 'vitest'
import {
  getSessionInfo,
  setAISessionId,
  clearAISession,
  consumeExpiryNotice,
  getAISessionId,
  normalizeProjectKey,
  setSessionTokens,
  getSessionGrowth,
  getReminderFacts,
  needsNewReminder,
  markNewReminded,
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

/**
 * The /new suggestion used to trigger on ABSOLUTE per-turn occupancy
 * (0.6 * ROTATE_AT_TOKENS = 72k). But the fixed cost of every turn — global
 * rules, the bot's system prompt, project CLAUDE.md files, MCP tool
 * definitions — is 25-35k tokens before the user says anything, so it fired on
 * brand-new conversations where nothing had accumulated.
 */
describe('session-store /new reminder', () => {
  it('does not nag a fresh session whose first turn is already huge', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-huge')
    setSessionTokens('claude', path, 80_000) // baseline: all fixed overhead
    expect(needsNewReminder('claude', path)).toBe(false)
  })

  it('still does not nag when occupancy barely moves off a huge baseline', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-flat')
    setSessionTokens('claude', path, 80_000)
    setSessionTokens('claude', path, 90_000)
    expect(getSessionGrowth('claude', path)).toBe(10_000)
    expect(needsNewReminder('claude', path)).toBe(false)
  })

  it('nags once the conversation itself has grown', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-grown')
    setSessionTokens('claude', path, 30_000)
    setSessionTokens('claude', path, 80_000)
    expect(getSessionGrowth('claude', path)).toBe(50_000)
    expect(needsNewReminder('claude', path)).toBe(true)
  })

  it('nags at most once per session', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-once')
    setSessionTokens('claude', path, 10_000)
    setSessionTokens('claude', path, 70_000)
    expect(needsNewReminder('claude', path)).toBe(true)
    markNewReminded('claude', path)
    expect(needsNewReminder('claude', path)).toBe(false)
    setSessionTokens('claude', path, 120_000)
    expect(needsNewReminder('claude', path)).toBe(false)
  })

  it('clearing the session resets the baseline so the next one starts over', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-reset')
    setSessionTokens('claude', path, 20_000)
    setSessionTokens('claude', path, 90_000)
    expect(needsNewReminder('claude', path)).toBe(true)

    clearAISession('claude', path)
    setAISessionId('claude', path, 'sid-reset-2')
    setSessionTokens('claude', path, 90_000) // fresh baseline, same big overhead
    expect(getSessionGrowth('claude', path)).toBe(0)
    expect(needsNewReminder('claude', path)).toBe(false)
  })

  it('reports the numbers it claims in the message', () => {
    const path = p()
    setAISessionId('claude', path, 'sid-facts')
    setSessionTokens('claude', path, 25_000)
    setAISessionId('claude', path, 'sid-facts')
    setSessionTokens('claude', path, 61_000)
    const facts = getReminderFacts('claude', path)
    expect(facts.turns).toBe(2)
    expect(facts.growth).toBe(36_000)
    expect(facts.occupancy).toBe(61_000)
  })
})
