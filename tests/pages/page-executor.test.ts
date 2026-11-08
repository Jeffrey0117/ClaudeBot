import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePageDirectives,
  stripPageDirectives,
  publishPageDirective,
} from '../../src/utils/page-executor.js'
import { listPages } from '../../src/pages/page-store.js'

describe('@page parsing', () => {
  it('reads path and title', () => {
    expect(parsePageDirectives('hello\n@page(out/btc.html|比特幣)\nbye')).toEqual([
      expect.objectContaining({ path: 'out/btc.html', title: '比特幣' }),
    ])
  })

  it('falls back to the file name when no title is given', () => {
    expect(parsePageDirectives('@page(out/btc.html)')[0].title).toBe('btc')
  })

  it('ignores directives in code blocks and mid-sentence', () => {
    expect(parsePageDirectives('```\n@page(a.html)\n```')).toEqual([])
    expect(parsePageDirectives('用 @page(a.html) 來發布')).toEqual([])
  })

  it('strips the directive from displayed text', () => {
    expect(stripPageDirectives('hello\n@page(a.html|t)\nbye')).toBe('hello\n\nbye')
  })
})

describe('publishPageDirective', () => {
  let root: string
  let pagesDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'page-root-'))
    pagesDir = mkdtempSync(join(tmpdir(), 'page-store-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(pagesDir, { recursive: true, force: true })
  })

  const directive = (path: string) => ({ type: 'page' as const, path, title: 'T', raw: '' })

  it('stores the page and returns its public and overview urls', async () => {
    writeFileSync(join(root, 'a.html'), '<p>x</p>')
    const out = await publishPageDirective(directive('a.html'), {
      projectPath: root, pagesDir, publicBase: 'https://a.example.com',
    })
    const [page] = await listPages(pagesDir)
    expect(out.url).toBe(`https://a.example.com/p/${page.id}`)
    expect(out.overviewUrl).toMatch(/^https:\/\/a\.example\.com\/p\/[a-f0-9]{32}$/)
    expect(out.overviewUrl).not.toBe(out.url)
  })

  it('refuses files outside the allowed roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'page-outside-'))
    writeFileSync(join(outside, 'a.html'), 'x')
    await expect(publishPageDirective(directive(join(outside, 'a.html')), {
      projectPath: root, pagesDir, publicBase: 'https://a.example.com', extraRoots: [],
    })).rejects.toThrow(/路徑/)
    rmSync(outside, { recursive: true, force: true })
    expect(await listPages(pagesDir)).toEqual([])
  })

  it('refuses oversized files', async () => {
    writeFileSync(join(root, 'big.html'), 'x'.repeat(6 * 1024 * 1024))
    await expect(publishPageDirective(directive('big.html'), {
      projectPath: root, pagesDir, publicBase: 'https://a.example.com',
    })).rejects.toThrow(/太大/)
  })

  it('fails loudly without a public url instead of handing out a dead link', async () => {
    writeFileSync(join(root, 'a.html'), 'x')
    await expect(publishPageDirective(directive('a.html'), {
      projectPath: root, pagesDir, publicBase: '',
    })).rejects.toThrow(/公開網址/)
    expect(await listPages(pagesDir)).toEqual([])
  })
})
