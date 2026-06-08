import { describe, it, expect } from 'vitest'
import { CdpEventRouter } from '../../../src/bot/vision/cdp-events.js'

describe('CdpEventRouter', () => {
  it('delivers dispatched params to a registered handler', () => {
    const r = new CdpEventRouter()
    const got: unknown[] = []
    r.on('Network.responseReceived', (p) => got.push(p))
    r.dispatch('Network.responseReceived', { requestId: 'x' })
    expect(got).toEqual([{ requestId: 'x' }])
  })
  it('supports multiple handlers for one method', () => {
    const r = new CdpEventRouter()
    let a = 0, b = 0
    r.on('M', () => { a++ }); r.on('M', () => { b++ })
    r.dispatch('M', {})
    expect([a, b]).toEqual([1, 1])
  })
  it('off removes a handler', () => {
    const r = new CdpEventRouter()
    let n = 0
    const h = () => { n++ }
    r.on('M', h); r.off('M', h)
    r.dispatch('M', {})
    expect(n).toBe(0)
  })
  it('dispatch to a method with no handlers is a no-op', () => {
    const r = new CdpEventRouter()
    expect(() => r.dispatch('None', {})).not.toThrow()
  })
  it('a throwing handler does not break the others', () => {
    const r = new CdpEventRouter()
    let reached = false
    r.on('M', () => { throw new Error('boom') })
    r.on('M', () => { reached = true })
    r.dispatch('M', {})
    expect(reached).toBe(true)
  })
})
