/**
 * Remote-intent detection: catch common remote-control requests in natural
 * language and turn them into ONE deterministic shell command, BEFORE handing
 * off to the (slow, sometimes-wrong) AI. Returns null when nothing matches, so
 * novel/complex requests still fall through to the model.
 *
 * The recipes encode the reliable way (force the right browser, autoplay YT,
 * real exe names) so we don't repeat the assistant's mistakes (opened Edge
 * instead of Chrome, opened the non-autoplay "audio" page, etc.).
 */

export interface RemoteAction {
  readonly kind: string
  readonly reply: string
  readonly command?: string // cmd.exe-native, runs via remote_execute_command (for commands that FINISH)
  readonly js?: string      // JS, runs in the CDP Chrome via remote_browser_eval
  readonly thenJs?: string  // optional 2nd JS, run ~4s after js (e.g. click first result after a search navigates)
  readonly spawnArgs?: readonly string[] // GUI launch → remote_spawn_detached({command:'cmd', args}) — returns instantly
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bedge\b/i, 'msedge'],
  [/\bfirefox\b/i, 'firefox'],
  [/\bchrome\b|谷歌|google\s*瀏覽器/i, 'chrome'],
]

const APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/小畫家|mspaint|paint/i, 'mspaint'],
  [/記事本|notepad/i, 'notepad'],
  [/小算盤|計算機|計算器|calc/i, 'calc'],
  [/檔案總管|檔案管理|explorer|file\s*explorer/i, 'explorer'],
  [/小工具|工作管理員|taskmgr/i, 'taskmgr'],
  [/小畫圖|painter/i, 'mspaint'],
  [/cmd|命令提示字元|終端機/i, 'cmd'],
  [/\bchrome\b|谷歌瀏覽器/i, 'chrome'],
  [/\bedge\b/i, 'msedge'],
]

const OPEN_VERB = /(開啟|打開|開一下|開個|開|啟動|跑|執行|open|launch|start|播放|播|看)/
const URL_RE = /https?:\/\/[^\s"'）)]+/i

/** Parse a number written as digits OR Chinese numerals (1–99). */
function parseNum(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const d: Record<string, number> = { 零: 0, 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  if (!/^[零一二兩三四五六七八九十]+$/.test(s)) return null
  if (s === '十') return 10
  if (s.length === 1) return d[s] ?? null
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    return (a ? (d[a] ?? 1) : 1) * 10 + (b ? (d[b] ?? 0) : 0)
  }
  return d[s[0]] ?? null
}

/** Try to map natural-language text to one deterministic remote command. */
export function detectRemoteIntent(text: string): RemoteAction | null {
  const t = text.trim()
  if (!t) return null

  // --- Browser media control via CDP (JS in the CDP Chrome) ---

  // Play a URL: navigate the CDP Chrome there (so it's the controllable tab,
  // not the user's separate main Chrome) with autoplay for YouTube.
  const urlPlay = t.match(URL_RE)
  if (urlPlay && /(播放|播|看|play)/i.test(t)) {
    let url = urlPlay[0].replace(/[.,；;。]+$/, '')
    if (/youtube\.com\/watch|youtu\.be\//i.test(url) && !/[?&]autoplay=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'autoplay=1'
    }
    return { kind: 'cdp-open', js: `location.href=${JSON.stringify(url)};'navigating'`, reply: `🌐 (CDP) 開並播放：${url}` }
  }

  const vol = t.match(/(?:音量|volume)\s*(?:到|=|:|至)?\s*(\d{1,3})/i)
  if (vol) {
    const n = Math.min(100, Math.max(0, parseInt(vol[1], 10))) / 100
    return { kind: 'cdp-volume', js: `var v=document.querySelector('video,audio');if(v){v.muted=false;v.volume=${n};}'${Math.round(n * 100)}%'`, reply: `🔊 音量 ${Math.round(n * 100)}%` }
  }
  if (/大聲|大聲點|再大聲|louder|大力一?點/i.test(t)) {
    return { kind: 'cdp-vol-up', js: "var v=document.querySelector('video,audio');if(v){v.muted=false;v.volume=Math.min(1,v.volume+0.15);}Math.round((document.querySelector('video,audio')?.volume||0)*100)+'%'", reply: '🔊 大聲一點' }
  }
  if (/小聲|小聲點|降低?音量|quieter|softer/i.test(t)) {
    return { kind: 'cdp-vol-down', js: "var v=document.querySelector('video,audio');if(v){v.volume=Math.max(0,v.volume-0.15);}Math.round((document.querySelector('video,audio')?.volume||0)*100)+'%'", reply: '🔉 小聲一點' }
  }
  if (/^(靜音|mute|閉嘴)$/i.test(t)) {
    return { kind: 'cdp-mute', js: "var v=document.querySelector('video,audio');if(v)v.muted=true;'muted'", reply: '🔇 靜音' }
  }
  if (/取消靜音|解除靜音|unmute|有聲音/i.test(t)) {
    return { kind: 'cdp-unmute', js: "var v=document.querySelector('video,audio');if(v)v.muted=false;'unmuted'", reply: '🔊 取消靜音' }
  }
  if (/^(暫停|停一下|暫停一下|pause)$|暫停(影片|音樂|播放|video)/i.test(t)) {
    return { kind: 'cdp-pause', js: "var v=document.querySelector('video,audio');if(v)v.pause();'paused'", reply: '⏸️ 暫停' }
  }
  if (/下一(首|個|支|部|集)|換一?[首個支]|換歌|換一首|跳過|skip|\bnext\b/i.test(t)) {
    return { kind: 'cdp-next', js: "(document.querySelector('.ytp-next-button')||{click(){}}).click();'next'", reply: '⏭️ 換下一個' }
  }
  if (/^(繼續播放?|繼續放|繼續|播放|播|放|play|resume)\s*(一?下)?\s*(音樂|音乐|影片|歌曲?|歌|video)?$/i.test(t)) {
    return { kind: 'cdp-play', js: "var v=document.querySelector('video,audio');if(v){v.play();}'playing'", reply: '▶️ 繼續播放' }
  }

  // --- Time-axis control (loop / seek) via CDP ---
  // Loop a range A–B sec: 「重複 10 到 20 秒」
  const lr = t.match(/([0-9零一二兩三四五六七八九十]+)\s*(?:到|至|-|~|–)\s*([0-9零一二兩三四五六七八九十]+)\s*秒/)
  if (lr && /(重複|跳針|一直|循環|loop|repeat)/i.test(t)) {
    const a = parseNum(lr[1]); const b = parseNum(lr[2])
    if (a != null && b != null && b > a) {
      return { kind: 'cdp-loop', js: `var v=document.querySelector('video,audio');if(window.__cbLoop)clearInterval(window.__cbLoop);if(v){v.currentTime=${a};v.play();window.__cbLoop=setInterval(function(){if(v.currentTime>=${b}||v.currentTime<${a})v.currentTime=${a};},150);}'loop ${a}-${b}'`, reply: `🔁 循環 ${a}–${b} 秒` }
    }
  }
  // Loop the first N sec: 「前 5 秒一直跳針」
  const lf = t.match(/(?:前|頭)\s*([0-9零一二兩三四五六七八九十]+)\s*秒/)
  if (lf && /(重複|跳針|一直|循環|loop|repeat)/i.test(t)) {
    const n = parseNum(lf[1])
    if (n != null && n > 0) {
      return { kind: 'cdp-loop', js: `var v=document.querySelector('video,audio');if(window.__cbLoop)clearInterval(window.__cbLoop);if(v){v.currentTime=0;v.play();window.__cbLoop=setInterval(function(){if(v.currentTime>=${n})v.currentTime=0;},150);}'loop 0-${n}'`, reply: `🔁 循環前 ${n} 秒` }
    }
  }
  // Stop loop
  if (/停止跳針|取消(循環|跳針)|不要(再?重複|跳針)|停止循環|別跳了|stop\s*loop/i.test(t)) {
    return { kind: 'cdp-loop-off', js: "if(window.__cbLoop){clearInterval(window.__cbLoop);window.__cbLoop=null;}'loop off'", reply: '⏹️ 停止循環' }
  }
  // Seek to second N: 「跳到第 30 秒」「從 30 秒播」
  const sk = t.match(/(?:跳到|快轉到|轉到|到|從|seek)\s*第?\s*([0-9零一二兩三四五六七八九十]+)\s*秒/)
  if (sk) {
    const n = parseNum(sk[1])
    if (n != null) {
      return { kind: 'cdp-seek', js: `var v=document.querySelector('video,audio');if(v){v.currentTime=${n};v.play();}'seek ${n}'`, reply: `⏩ 跳到第 ${n} 秒` }
    }
  }

  // Jump to chorus (heuristic ~28% in — most songs hit the chorus early-ish).
  // Only for a bare request; 「我要聽 X 的副歌」strips 副歌 and searches X instead.
  if (/^(跳到?|去|播|到)?\s*(副歌|chorus|高潮|精華)$/i.test(t)) {
    return { kind: 'cdp-chorus', js: "var v=document.querySelector('video,audio');if(v&&v.duration){v.currentTime=v.duration*0.28;v.play();}'chorus~'", reply: '🎶 跳到副歌（估約 28% 處）' }
  }

  // Search + play: 「我要聽 周杰倫 稻香」「播放 X 的 Y」「放 X」→ YT 搜尋,點第一個。
  const sp = t.match(/^(?:我?[要想]?聽|播放|播|放|搜尋?播放?|聽聽)\s*(.{2,})$/i)
  if (sp && !URL_RE.test(t)) {
    const q = sp[1]
      .replace(/^(我?[要想]?聽|播放|播|放|要|想)\s*/i, '')          // 2nd leading verb (我聽要聽 X)
      .replace(/的?(副歌|歌曲?|音樂|影片|video|mv|這首歌?|那首歌?)\s*$/i, '') // trailing noise
      .trim()
    if (q.length >= 2) {
      const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
      return {
        kind: 'cdp-search-play',
        js: `location.href=${JSON.stringify(url)};'searching'`,
        // Poll for the first result (the search page may still be loading) then
        // click it → navigates to the watch page (which autoplays).
        thenJs: "(function(){var n=0;var iv=setInterval(function(){var a=document.querySelector('ytd-video-renderer a#video-title,ytd-video-renderer a#thumbnail,a#video-title,ytd-video-renderer a');if(a){clearInterval(iv);a.click();}else if(++n>24){clearInterval(iv);}},500);})();'clicking first result'",
        reply: `🔎 搜尋並播放：${q}`,
      }
    }
  }

  // 1. Open / play a URL in a browser (handles YouTube autoplay + browser choice)
  const urlMatch = t.match(URL_RE)
  if (urlMatch && OPEN_VERB.test(t)) {
    let url = urlMatch[0].replace(/[.,；;。]+$/, '')
    const browser = (BROWSERS.find(([re]) => re.test(t)) ?? [, 'chrome'] as const)[1]
    if (/youtube\.com\/watch|youtu\.be\//i.test(url) && !/[?&]autoplay=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'autoplay=1'
    }
    return {
      kind: 'open-url',
      spawnArgs: ['/c', 'start', '', browser, url],
      reply: `🌐 用 ${browser} 開啟並播放：${url}`,
    }
  }

  // 2. Open a known desktop app (only when there's a clear open verb)
  if (OPEN_VERB.test(t)) {
    for (const [re, exe] of APPS) {
      if (re.test(t)) {
        return { kind: 'open-app', spawnArgs: ['/c', 'start', '', exe], reply: `🚀 已開啟 ${exe}` }
      }
    }
  }

  return null
}
