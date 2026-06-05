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
  readonly command?: string // cmd.exe-native, runs via remote_execute_command
  readonly js?: string      // JS, runs in the CDP Chrome via remote_browser_eval
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
  if (/^(暫停|停一下|暫停一下|pause)$|暫停(影片|音樂|播放|video)/i.test(t)) {
    return { kind: 'cdp-pause', js: "var v=document.querySelector('video,audio');if(v)v.pause();'paused'", reply: '⏸️ 暫停' }
  }
  if (/下一(首|個|支|部|集)|跳過|skip|\bnext\b/i.test(t)) {
    return { kind: 'cdp-next', js: "(document.querySelector('.ytp-next-button')||{click(){}}).click();'next'", reply: '⏭️ 下一個' }
  }
  if (/^(播放|播|play|resume|繼續播放|繼續播)$/i.test(t)) {
    return { kind: 'cdp-play', js: "var v=document.querySelector('video,audio');if(v){v.play();}'playing'", reply: '▶️ 播放' }
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
      command: `start ${browser} "${url}"`,
      reply: `🌐 用 ${browser} 開啟並播放：${url}`,
    }
  }

  // 2. Open a known desktop app (only when there's a clear open verb)
  if (OPEN_VERB.test(t)) {
    for (const [re, exe] of APPS) {
      if (re.test(t)) {
        return { kind: 'open-app', command: `start "" ${exe}`, reply: `🚀 已開啟 ${exe}` }
      }
    }
  }

  return null
}
