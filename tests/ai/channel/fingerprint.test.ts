import { describe, it, expect } from 'vitest'
import { computeFingerprint } from '../../../src/ai/channel/fingerprint.js'

describe('computeFingerprint', () => {
  const base = { model: 'sonnet', pairingCode: null, isAdmin: false, browser: false, systemPromptVersion: 1 }
  it('is stable for identical inputs', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }))
  })
  it('changes when the model changes', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, model: 'opus' }))
  })
  it('changes when the pairing code changes', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, pairingCode: 'abc123' }))
  })
  it('changes when admin status changes', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, isAdmin: true }))
  })
})
