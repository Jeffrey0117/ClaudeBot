import { describe, it, expect, beforeEach } from 'vitest'
import { tryReserve, settle, remoteId } from '../../src/plugins/allot/quota-engine.js'
import {
  getStore,
  updateConfig,
  ensureRemote,
  getRemoteState,
  resetRemoteUsage,
} from '../../src/plugins/allot/allot-store.js'

/**
 * These are money bugs: a reservation that is never released, or released by a
 * different amount than it was taken, locks a remote user out permanently —
 * only settle decrements pendingReserve.
 */
let seq = 0
function freshChat(): number {
  // positive ids; remoteId() stringifies chatId(:threadId)
  return 900_000 + seq++
}

function pending(chatId: number): number {
  return getRemoteState(remoteId(chatId, undefined))?.pendingReserve ?? 0
}

describe('allot reserve/settle accounting', () => {
  beforeEach(() => {
    // Enabled, with reserveAmount deliberately NOT equal to the per-remote
    // rate budget — that mismatch is what the old settle got wrong.
    updateConfig({
      enabled: true,
      mode: 'manual',
      rateBudget: 10,
      weeklyBudget: 1500,
      ratioPercent: 20,
      marginPercent: 10,
      reserveAmount: 3,
    })
  })

  it('releases exactly what it reserved', () => {
    const chatId = freshChat()
    ensureRemote(remoteId(chatId, undefined), 'test')
    resetRemoteUsage(remoteId(chatId, undefined))

    const before = pending(chatId)
    const res = tryReserve(chatId, undefined)
    expect(res.allowed).toBe(true)
    const held = pending(chatId) - before
    expect(held).toBeGreaterThan(0)

    settle(chatId, undefined, 1)
    expect(pending(chatId)).toBe(before)
  })

  it('does not strand reservations when several are in flight', () => {
    // Needs a budget generous enough to hold more than one reservation
    updateConfig({ rateBudget: 100, weeklyBudget: 5000, reserveAmount: 3 })
    const chatId = freshChat()
    ensureRemote(remoteId(chatId, undefined), 'test')
    resetRemoteUsage(remoteId(chatId, undefined))

    expect(tryReserve(chatId, undefined).allowed).toBe(true)
    expect(tryReserve(chatId, undefined).allowed).toBe(true)
    expect(tryReserve(chatId, undefined).allowed).toBe(true)
    const afterThree = pending(chatId)
    expect(afterThree).toBe(9) // 3 x reserveAmount

    // settling one releases exactly one reservation, not all of them
    settle(chatId, undefined, 1)
    expect(pending(chatId)).toBe(6)

    settle(chatId, undefined, 1)
    settle(chatId, undefined, 1)
    expect(pending(chatId)).toBe(0)
  })

  it('releases the amount actually taken when reserveAmount changed meanwhile', () => {
    // The asymmetry that stranded quota: reserve recorded one amount, settle
    // subtracted a fresh read of config.reserveAmount. An admin lowering
    // reserveAmount (or auto mode moving the budget) between a request starting
    // and finishing left the difference pending forever.
    updateConfig({ rateBudget: 100, weeklyBudget: 5000, reserveAmount: 3 })
    const chatId = freshChat()
    ensureRemote(remoteId(chatId, undefined), 'test')
    resetRemoteUsage(remoteId(chatId, undefined))

    expect(tryReserve(chatId, undefined).allowed).toBe(true)
    expect(pending(chatId)).toBe(3)

    updateConfig({ reserveAmount: 1 })
    settle(chatId, undefined, 1)

    // old behaviour subtracted 1 and stranded 2 permanently
    expect(pending(chatId)).toBe(0)
  })

  it('a settle with nothing reserved does not invent a refund', () => {
    const chatId = freshChat()
    ensureRemote(remoteId(chatId, undefined), 'test')
    resetRemoteUsage(remoteId(chatId, undefined))

    settle(chatId, undefined, 1)
    expect(pending(chatId)).toBe(0)
  })

  it('reserve then settle repeatedly returns to zero (no monotonic growth)', () => {
    const chatId = freshChat()
    ensureRemote(remoteId(chatId, undefined), 'test')
    resetRemoteUsage(remoteId(chatId, undefined))

    for (let i = 0; i < 5; i++) {
      const r = tryReserve(chatId, undefined)
      if (!r.allowed) break
      settle(chatId, undefined, 1)
      // the thing that locked users out: pendingReserve creeping up each round
      expect(pending(chatId)).toBe(0)
    }
  })

  it('writes to the isolated test store, not real quota data', () => {
    // guards the CLAUDEBOT_STATE_DIR seam in allot-store
    expect(process.env.CLAUDEBOT_STATE_DIR).toBeTruthy()
    expect(getStore()).toBeTruthy()
  })
})
