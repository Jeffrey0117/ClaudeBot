import { describe, it, expect } from 'vitest'
import { claimCommand, completeCommand } from '../../src/dashboard/command-reader.js'
import type { DashboardCommand } from '../../src/dashboard/types.js'

function cmd(over: Partial<DashboardCommand>): DashboardCommand {
  return {
    id: 'c1',
    targetBot: null,
    type: 'prompt',
    payload: {},
    createdAt: 0,
    status: 'pending',
    claimedBy: null,
    ...over,
  }
}

describe('claimCommand', () => {
  it('marks only the matching command as claimed by the bot', () => {
    const a = cmd({ id: 'a' })
    const b = cmd({ id: 'b' })
    const out = claimCommand([a, b], a, 'bot1')
    expect(out.find((c) => c.id === 'a')).toMatchObject({ status: 'claimed', claimedBy: 'bot1' })
    expect(out.find((c) => c.id === 'b')).toMatchObject({ status: 'pending', claimedBy: null })
  })

  it('does not mutate the input array or items', () => {
    const a = cmd({ id: 'a' })
    const input = [a]
    claimCommand(input, a, 'bot1')
    expect(a.status).toBe('pending')
    expect(input[0]).toBe(a)
  })
})

describe('completeCommand', () => {
  it('sets the matching command to completed', () => {
    const out = completeCommand([cmd({ id: 'a' }), cmd({ id: 'b' })], 'a', 'completed')
    expect(out.find((c) => c.id === 'a')?.status).toBe('completed')
    expect(out.find((c) => c.id === 'b')?.status).toBe('pending')
  })

  it('sets the matching command to failed', () => {
    const out = completeCommand([cmd({ id: 'a' })], 'a', 'failed')
    expect(out[0].status).toBe('failed')
  })
})
