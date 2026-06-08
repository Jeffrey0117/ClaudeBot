import { describe, it, expect } from 'vitest'
import { buildGmShim, buildDownloadShim } from '../../../src/bot/vision/gm-shim.js'

describe('buildGmShim', () => {
  it('embeds the binding name and the key GM functions', () => {
    const s = buildGmShim('__cbGM')
    expect(s).toContain('__cbGM')
    expect(s).toContain('GM_download')
    expect(s).toContain('GM_xmlhttpRequest')
    expect(s).toContain('GM_addStyle')
    expect(s).toContain('GM_setValue')
    expect(s).toContain('window.GM =')
  })
  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(buildGmShim('__cbGM'))).not.toThrow()
  })
})

describe('buildDownloadShim', () => {
  it('hooks anchor downloads and reports via the binding', () => {
    const s = buildDownloadShim('__cbGM')
    expect(s).toContain('__cbGM')
    expect(s).toContain('HTMLAnchorElement.prototype.click')
    expect(s).toContain('filedata')
    expect(s).toContain("a[download]")
  })
  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(buildDownloadShim('__cbGM'))).not.toThrow()
  })
})
