import { describe, it, expect } from 'vitest'
import { formatFindResult, type X1FindResult } from '../../src/bot/x1-format.js'

const EMPTY: X1FindResult = { matches: [], offers: [], projects: [] }

describe('formatFindResult', () => {
  it('says nothing was found, echoing the task safely', () => {
    const text = formatFindResult('<b>x</b>', EMPTY)
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(text).not.toContain('<b>x</b>')
  })

  it('treats a missing or malformed payload as nothing found', () => {
    expect(formatFindResult('x', null)).toBe(formatFindResult('x', EMPTY))
    expect(formatFindResult('x', { matches: 'nope' } as unknown as X1FindResult)).toBe(
      formatFindResult('x', EMPTY),
    )
  })

  it('shows callable capabilities with flags and parameters', () => {
    const text = formatFindResult('short url', {
      matches: [
        {
          id: 'upimg.shorten_url',
          tool: 'upimg_shorten_url',
          description: 'Create a short URL',
          effect: 'write',
          required: ['url'],
          optional: ['password'],
          proven: true,
          blocked: false,
          failing: false,
        },
      ],
      offers: [],
      projects: [],
    })
    expect(text).toContain('<b>upimg.shorten_url</b>')
    expect(text).toContain('Create a short URL')
    expect(text).toContain('url')
    expect(text).toContain('[password]')
    expect(text).toContain('用過')
    expect(text).toContain('會寫入')
  })

  it('marks blocked and failing capabilities', () => {
    const text = formatFindResult('x', {
      matches: [
        {
          id: 'a.b',
          tool: 'a_b',
          description: 'd',
          effect: 'read',
          required: [],
          optional: [],
          proven: false,
          blocked: true,
          failing: true,
        },
      ],
      offers: [],
      projects: [],
    })
    expect(text).toContain('沒權限')
    expect(text).toContain('最近失敗')
    expect(text).not.toContain('會寫入')
  })

  it('shows repository offers with how to use them', () => {
    const text = formatFindResult('x', {
      matches: [],
      offers: [
        {
          id: 'newebpay-kit.period_subscription',
          how: 'import',
          use: "const { createNewebpay } = require('newebpay-kit')",
          what: 'Recurring <billing>',
        },
      ],
      projects: [],
    })
    expect(text).toContain('<b>newebpay-kit.period_subscription</b>')
    expect(text).toContain('Recurring &lt;billing&gt;')
    expect(text).toContain("<code>const { createNewebpay } = require(&#39;newebpay-kit&#39;)</code>")
  })

  it('lists related projects', () => {
    const text = formatFindResult('x', {
      matches: [],
      offers: [],
      projects: [{ id: 'pokkit', capabilities: 19 }],
    })
    expect(text).toContain('pokkit')
    expect(text).toContain('19')
  })

  it('stays under the Telegram message limit', () => {
    const matches = Array.from({ length: 40 }, (_, i) => ({
      id: `p.tool_${i}`,
      tool: `p_tool_${i}`,
      description: 'x'.repeat(500),
      effect: 'read',
      required: [],
      optional: [],
      proven: false,
      blocked: false,
      failing: false,
    }))
    expect(formatFindResult('x', { matches, offers: [], projects: [] }).length).toBeLessThanOrEqual(4000)
  })
})
