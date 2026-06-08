import { describe, it, expect, beforeEach } from 'vitest'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { addScript, getScript, listScripts, removeScript, __resetForTest, type StoredScript } from '../../../src/bot/vision/userscript-store.js'

const DATA = resolve('data/userscripts.json')
const mk = (over: Partial<StoredScript> = {}): StoredScript => ({
  name: 'igdl', code: '//x', match: ['*://*.instagram.com/*'], grants: ['GM_download'], addedAt: 1, ...over,
})

describe('userscript store', () => {
  beforeEach(() => {
    try { rmSync(DATA) } catch { /* missing is fine */ }
    __resetForTest()
  })
  it('adds and gets by name', () => {
    addScript(mk())
    expect(getScript('igdl')?.match).toContain('*://*.instagram.com/*')
    expect(getScript('nope')).toBeUndefined()
  })
  it('lists all scripts', () => {
    addScript(mk({ name: 'a' }))
    addScript(mk({ name: 'b' }))
    expect(listScripts().map((s) => s.name).sort()).toEqual(['a', 'b'])
  })
  it('removes by name', () => {
    addScript(mk())
    expect(removeScript('igdl')).toBe(true)
    expect(removeScript('igdl')).toBe(false)
    expect(getScript('igdl')).toBeUndefined()
  })
})
