import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  savePage,
  listPages,
  readPage,
  getIndexToken,
  isAllowedPageSource,
  normalizePublicBase,
  renderOverview,
} from '../../src/pages/page-store.js'
import { handlePageRequest } from '../../src/pages/page-route.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pages-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('page store', () => {
  it('saves a page under an unguessable id and reads it back', async () => {
    const page = await savePage(dir, '<h1>hi</h1>', 'BTC', 1000)
    expect(page.id).toMatch(/^[a-f0-9]{32}$/)
    expect(await readPage(dir, page.id)).toBe('<h1>hi</h1>')
  })

  it('refuses ids that are not plain hex (no path traversal)', async () => {
    writeFileSync(join(dir, 'secret.html'), 'nope')
    expect(await readPage(dir, '../secret')).toBeNull()
    expect(await readPage(dir, 'secret')).toBeNull()
  })

  it('lists newest first and ignores unrelated files', async () => {
    const a = await savePage(dir, 'a', 'old', 1000)
    const b = await savePage(dir, 'b', 'new', 2000)
    writeFileSync(join(dir, 'junk.json'), '{}')
    expect((await listPages(dir)).map((p) => p.id)).toEqual([b.id, a.id])
  })

  it('keeps the same overview token across calls', async () => {
    const first = await getIndexToken(dir)
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(await getIndexToken(dir)).toBe(first)
  })

  it('escapes titles in the overview', () => {
    const html = renderOverview([{ id: 'a'.repeat(32), title: '<script>x</script>', createdAt: 0 }])
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('isAllowedPageSource', () => {
  it('accepts html inside an allowed root only', () => {
    const root = join(dir, 'root')
    mkdirSync(root)
    writeFileSync(join(root, 'ok.html'), 'x')
    writeFileSync(join(root, '.env'), 'x')
    writeFileSync(join(dir, 'outside.html'), 'x')
    expect(isAllowedPageSource(join(root, 'ok.html'), [root])).toBe(true)
    expect(isAllowedPageSource(join(root, '.env'), [root])).toBe(false)
    expect(isAllowedPageSource(join(dir, 'outside.html'), [root])).toBe(false)
    expect(isAllowedPageSource(join(root, 'missing.html'), [root])).toBe(false)
  })

  it('rejects a link that escapes the root', () => {
    const root = join(dir, 'root')
    mkdirSync(root)
    writeFileSync(join(dir, 'outside.html'), 'x')
    try {
      symlinkSync(join(dir, 'outside.html'), join(root, 'link.html'))
    } catch {
      return // creating symlinks needs privileges on some Windows setups
    }
    expect(isAllowedPageSource(join(root, 'link.html'), [root])).toBe(false)
  })
})

describe('normalizePublicBase', () => {
  it('turns relay websocket urls into web urls', () => {
    expect(normalizePublicBase('wss://a.example.com/')).toBe('https://a.example.com')
    expect(normalizePublicBase('ws://a.example.com')).toBe('http://a.example.com')
    expect(normalizePublicBase('https://a.example.com')).toBe('https://a.example.com')
  })

  it('returns empty for junk', () => {
    expect(normalizePublicBase('')).toBe('')
    expect(normalizePublicBase('not a url')).toBe('')
  })
})

describe('page route', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (handlePageRequest(req, res, dir)) return
      res.writeHead(200)
      res.end('fallthrough')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  it('serves a page sandboxed, unindexed and away from the relay origin', async () => {
    const page = await savePage(dir, '<h1>hi</h1>', 'BTC')
    const res = await fetch(`${base}/p/${page.id}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('serves the overview only at its token', async () => {
    const page = await savePage(dir, 'x', '我的頁面')
    const token = await getIndexToken(dir)
    const res = await fetch(`${base}/p/${token}`)
    expect(await res.text()).toContain(page.id)
  })

  it('404s unknown ids and never lists at /p/', async () => {
    await savePage(dir, 'x', 't')
    expect((await fetch(`${base}/p/${'0'.repeat(32)}`)).status).toBe(404)
    expect(await (await fetch(`${base}/p/`)).text()).toBe('fallthrough')
    expect(await (await fetch(`${base}/relay-url`)).text()).toBe('fallthrough')
  })

  it('does not accept writes', async () => {
    const page = await savePage(dir, 'x', 't')
    expect((await fetch(`${base}/p/${page.id}`, { method: 'POST' })).status).toBe(405)
  })
})
