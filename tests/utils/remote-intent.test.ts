import { describe, it, expect } from 'vitest'
import { detectRemoteIntent } from '../../src/utils/remote-intent.js'

describe('detectRemoteIntent — fall-through', () => {
  it('returns null for empty / whitespace', () => {
    expect(detectRemoteIntent('')).toBeNull()
    expect(detectRemoteIntent('   ')).toBeNull()
  })

  it('returns null for unrelated chatter (falls through to the model)', () => {
    expect(detectRemoteIntent('今天天氣如何')).toBeNull()
  })
})

describe('detectRemoteIntent — seek by seconds', () => {
  it('parses arabic numerals', () => {
    const r = detectRemoteIntent('跳到第30秒')
    expect(r?.kind).toBe('cdp-seek')
    expect(r?.js).toContain('currentTime=30')
  })

  it('parses chinese numeral 三十 → 30', () => {
    expect(detectRemoteIntent('跳到第三十秒')?.js).toContain('currentTime=30')
  })

  it('parses bare 十 → 10', () => {
    expect(detectRemoteIntent('跳到第十秒')?.js).toContain('currentTime=10')
  })

  it('parses 二十五 → 25', () => {
    expect(detectRemoteIntent('跳到第二十五秒')?.js).toContain('currentTime=25')
  })

  it('parses 兩 → 2', () => {
    expect(detectRemoteIntent('跳到第兩秒')?.js).toContain('currentTime=2')
  })
})

describe('detectRemoteIntent — seek by percentage', () => {
  it('跳到50% → 0.5', () => {
    const r = detectRemoteIntent('跳到50%')
    expect(r?.kind).toBe('cdp-seek-pct')
    expect(r?.js).toContain('v.duration*0.5')
  })

  it('clamps over-100% to 100%', () => {
    expect(detectRemoteIntent('跳到500%')?.js).toContain('v.duration*1')
  })

  it('跳到一半 → 0.5', () => {
    const r = detectRemoteIntent('跳到一半')
    expect(r?.kind).toBe('cdp-seek-pct')
    expect(r?.js).toContain('v.duration*0.5')
  })

  it('跳到開頭 → 0', () => {
    expect(detectRemoteIntent('跳到開頭')?.js).toContain('currentTime=0')
  })
})

describe('detectRemoteIntent — chorus', () => {
  it('bare 副歌 → chorus heuristic', () => {
    const r = detectRemoteIntent('副歌')
    expect(r?.kind).toBe('cdp-chorus')
    expect(r?.js).toContain('v.duration*0.28')
  })

  it('切到副歌 → chorus (the verb that used to miss)', () => {
    expect(detectRemoteIntent('切到副歌')?.kind).toBe('cdp-chorus')
  })

  it('「我要聽 X 的副歌」 is search-play, NOT chorus', () => {
    const r = detectRemoteIntent('我要聽周杰倫的副歌')
    expect(r?.kind).toBe('cdp-search-play')
    expect(r?.reply).toContain('周杰倫')
  })
})

describe('detectRemoteIntent — volume', () => {
  it('音量到50 → 50%', () => {
    const r = detectRemoteIntent('音量到50')
    expect(r?.kind).toBe('cdp-volume')
    expect(r?.js).toContain('v.volume=0.5')
  })

  it('clamps 音量到500 → 100%', () => {
    expect(detectRemoteIntent('音量到500')?.js).toContain('v.volume=1')
  })

  it('大聲點 → volume up', () => {
    expect(detectRemoteIntent('大聲點')?.kind).toBe('cdp-vol-up')
  })
})

describe('detectRemoteIntent — transport', () => {
  it('exact 靜音 → mute', () => {
    expect(detectRemoteIntent('靜音')?.kind).toBe('cdp-mute')
  })

  it('「幫我靜音一下」 is not an exact mute match → null', () => {
    expect(detectRemoteIntent('幫我靜音一下')).toBeNull()
  })

  it('繼續播放 → resume play', () => {
    expect(detectRemoteIntent('繼續播放')?.kind).toBe('cdp-play')
  })

  it('下一首 → next', () => {
    expect(detectRemoteIntent('下一首')?.kind).toBe('cdp-next')
  })
})

describe('detectRemoteIntent — search vs play disambiguation', () => {
  it('「播放音樂」 (generic) → resume play', () => {
    expect(detectRemoteIntent('播放音樂')?.kind).toBe('cdp-play')
  })

  it('「播放周杰倫」 (named) → search-play', () => {
    const r = detectRemoteIntent('播放周杰倫')
    expect(r?.kind).toBe('cdp-search-play')
    expect(r?.reply).toContain('周杰倫')
  })

  it('「我要聽 周杰倫 稻香」 → search-play with full query', () => {
    const r = detectRemoteIntent('我要聽 周杰倫 稻香')
    expect(r?.kind).toBe('cdp-search-play')
    expect(r?.js).toContain(encodeURIComponent('周杰倫 稻香'))
  })

  it('does not search-play when a URL is present', () => {
    expect(detectRemoteIntent('我要聽 https://x.com')?.kind).not.toBe('cdp-search-play')
  })
})

describe('detectRemoteIntent — URL play', () => {
  it('appends autoplay=1 for a YouTube link', () => {
    const r = detectRemoteIntent('播放 https://youtu.be/abc')
    expect(r?.kind).toBe('cdp-open')
    expect(r?.js).toContain('youtu.be/abc?autoplay=1')
  })

  it('strips trailing punctuation from the URL', () => {
    const r = detectRemoteIntent('播放 https://x.com/a。')
    expect(r?.js).toContain('https://x.com/a')
    expect(r?.js).not.toContain('。')
  })
})

describe('detectRemoteIntent — loop', () => {
  it('「重複 10 到 20 秒」 → loop range', () => {
    const r = detectRemoteIntent('重複 10 到 20 秒')
    expect(r?.kind).toBe('cdp-loop')
    expect(r?.reply).toContain('10')
    expect(r?.reply).toContain('20')
  })

  it('rejects an inverted range (b <= a)', () => {
    expect(detectRemoteIntent('重複 20 到 10 秒')?.kind).not.toBe('cdp-loop')
  })

  it('「前 5 秒一直跳針」 → loop first 5s', () => {
    expect(detectRemoteIntent('前 5 秒一直跳針')?.kind).toBe('cdp-loop')
  })
})

describe('detectRemoteIntent — desktop apps (detached spawn)', () => {
  it('打開小畫家 → mspaint', () => {
    const r = detectRemoteIntent('打開小畫家')
    expect(r?.kind).toBe('open-app')
    expect(r?.spawnArgs).toEqual(['/c', 'start', '', 'mspaint'])
  })

  it('開啟記事本 → notepad', () => {
    expect(detectRemoteIntent('開啟記事本')?.spawnArgs).toEqual(['/c', 'start', '', 'notepad'])
  })
})
