import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface TidbitEntry {
  readonly category: string
  readonly emoji: string
  readonly text: string
}

interface ReelScriptSnippet {
  readonly en: string
  readonly zh: string
  readonly videoTitle: string
  readonly channel: string
  readonly vocabulary?: readonly { word: string; translation: string }[]
}

interface ReelScriptVideo {
  readonly id: string
  readonly title: string
  readonly channel: string
  readonly duration: number
}

interface ReelScriptVideoList {
  readonly total: number
  readonly videos: readonly ReelScriptVideo[]
}

interface ReelScriptSegment {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly translation?: string
}

interface ReelScriptAudioResponse {
  readonly audioUrl: string
  readonly segments: readonly ReelScriptSegment[]
}

export interface AudioTidbit {
  readonly type: 'audio'
  readonly audioUrl: string
  readonly caption: string
  readonly title: string
}

export type TidbitResult =
  | { readonly type: 'text'; readonly content: string }
  | AudioTidbit

const TIDBITS_PATH = resolve('data/tidbits.json')
const REELSCRIPT_API = 'https://reelscript.isnowfriend.com/api/public'
const REELSCRIPT_BASE = 'https://reelscript.isnowfriend.com'

let pool: TidbitEntry[] = []
let usedIndices = new Set<number>()

// Cache video list to avoid repeated fetches
let cachedVideos: readonly ReelScriptVideo[] = []
let videoCacheTime = 0
const VIDEO_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

async function fetchVideoList(): Promise<readonly ReelScriptVideo[]> {
  const now = Date.now()
  if (cachedVideos.length > 0 && now - videoCacheTime < VIDEO_CACHE_TTL) {
    return cachedVideos
  }

  const res = await fetch(`${REELSCRIPT_API}/videos?limit=50`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) return []

  const data = await res.json() as ReelScriptVideoList
  cachedVideos = data.videos
  videoCacheTime = now
  return cachedVideos
}

async function fetchReelScriptAudio(): Promise<AudioTidbit | null> {
  try {
    const videos = await fetchVideoList()
    if (videos.length === 0) return null

    // Pick a random video
    const video = videos[Math.floor(Math.random() * videos.length)]

    // Fetch audio (may trigger ffmpeg extraction, so longer timeout)
    const res = await fetch(`${REELSCRIPT_API}/videos/${video.id}/audio`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null

    const data = await res.json() as ReelScriptAudioResponse
    if (!data.audioUrl) return null

    // Build caption from first few segments
    const preview = data.segments.slice(0, 3)
    const captionLines: string[] = [
      `🎧 ${video.title}`,
      `📺 ${video.channel}`,
      '',
    ]

    for (const seg of preview) {
      captionLines.push(`🇬🇧 ${seg.text}`)
      if (seg.translation) {
        captionLines.push(`🇹🇼 ${seg.translation}`)
      }
      captionLines.push('')
    }

    const fullUrl = data.audioUrl.startsWith('http')
      ? data.audioUrl
      : `${REELSCRIPT_BASE}${data.audioUrl}`

    return {
      type: 'audio',
      audioUrl: fullUrl,
      caption: captionLines.join('\n').trim(),
      title: video.title,
    }
  } catch {
    return null
  }
}

async function fetchReelScriptSnippet(): Promise<TidbitEntry | null> {
  try {
    const res = await fetch(`${REELSCRIPT_API}/snippet/random`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return null

    const data = await res.json() as ReelScriptSnippet

    const lines: string[] = []
    lines.push(`🇬🇧 ${data.en}`)
    lines.push(`🇹🇼 ${data.zh}`)

    if (data.vocabulary && data.vocabulary.length > 0) {
      const words = data.vocabulary.slice(0, 3)
        .map((v) => `  • *${v.word}* — ${v.translation}`)
        .join('\n')
      lines.push(`\n${words}`)
    }

    return {
      category: data.videoTitle,
      emoji: '🎧',
      text: lines.join('\n'),
    }
  } catch {
    return null
  }
}

function loadTidbits(): TidbitEntry[] {
  try {
    const raw = readFileSync(TIDBITS_PATH, 'utf-8')
    return JSON.parse(raw) as TidbitEntry[]
  } catch {
    return getDefaultTidbits()
  }
}

function getDefaultTidbits(): TidbitEntry[] {
  return [
    // 冷知識
    { category: '冷知識', emoji: '🧊', text: '蜂蜜永遠不會變質。考古學家在埃及金字塔中發現了 3000 年前的蜂蜜，仍然可以食用。' },
    { category: '冷知識', emoji: '🧊', text: '章魚有三顆心臟、藍色的血液，而且每隻觸手都有自己的「迷你大腦」。' },
    { category: '冷知識', emoji: '🧊', text: '瑞士曾經不小心入侵了列支敦士登（三次），每次都是因為士兵迷路。' },
    { category: '冷知識', emoji: '🧊', text: 'WiFi 不是任何單字的縮寫，它只是一個品牌名稱。' },
    { category: '冷知識', emoji: '🧊', text: '地球上的樹木數量比銀河系的星星還多 — 約 3 兆棵 vs 1000-4000 億顆。' },
    { category: '冷知識', emoji: '🧊', text: '一張紙對折 42 次的厚度可以從地球到月球。' },
    { category: '冷知識', emoji: '🧊', text: '鯊魚比樹還早出現在地球上。鯊魚存在了 4 億年，樹只有 3.5 億年。' },
    { category: '冷知識', emoji: '🧊', text: '牛津大學比阿茲特克帝國還早成立。牛津 1096 年，阿茲特克 1325 年。' },
    { category: '冷知識', emoji: '🧊', text: '你的手機比 NASA 送人上月球時用的電腦強大好幾百萬倍。' },
    { category: '冷知識', emoji: '🧊', text: '如果把人體的 DNA 全部展開串連，長度大約是冥王星來回兩趟。' },
    { category: '冷知識', emoji: '🧊', text: '貓不能嚐到甜味，因為牠們缺少甜味受體的基因。' },
    { category: '冷知識', emoji: '🧊', text: '全世界的螞蟻總重量大約等同於全人類的總重量。' },

    // 英文單字
    { category: '單字', emoji: '📖', text: 'serendipity (n.) — 意外發現美好事物的能力\n例句: Finding that bug led to a serendipity — we discovered a much better architecture.' },
    { category: '單字', emoji: '📖', text: 'ephemeral (adj.) — 短暫的、轉瞬即逝的\n例句: The ephemeral nature of cache makes it unsuitable for persistent data.' },
    { category: '單字', emoji: '📖', text: 'ubiquitous (adj.) — 無處不在的\n例句: JavaScript has become ubiquitous in modern web development.' },
    { category: '單字', emoji: '📖', text: 'pragmatic (adj.) — 務實的\n例句: A pragmatic approach would be to ship the MVP first and iterate.' },
    { category: '單字', emoji: '📖', text: 'idempotent (adj.) — 冪等的（多次執行結果相同）\n例句: PUT requests should be idempotent — calling them twice has the same effect as once.' },
    { category: '單字', emoji: '📖', text: 'resilient (adj.) — 有韌性的、能恢復的\n例句: A resilient system gracefully handles failures without crashing.' },
    { category: '單字', emoji: '📖', text: 'verbose (adj.) — 冗長的\n例句: The error messages are too verbose; users don\'t need stack traces.' },
    { category: '單字', emoji: '📖', text: 'immutable (adj.) — 不可變的\n例句: In functional programming, data structures are immutable by default.' },
    { category: '單字', emoji: '📖', text: 'caveat (n.) — 注意事項、附帶條件\n例句: One caveat with this approach: it only works on Node 18+.' },
    { category: '單字', emoji: '📖', text: 'bottleneck (n.) — 瓶頸\n例句: The database query is the bottleneck — everything else is fast.' },
    { category: '單字', emoji: '📖', text: 'leverage (v.) — 利用、善用\n例句: We can leverage the existing cache to reduce API calls.' },
    { category: '單字', emoji: '📖', text: 'deprecate (v.) — 棄用、不建議使用\n例句: This API endpoint has been deprecated in favor of the new v2 version.' },

    // 開發小提示
    { category: '提示', emoji: '💡', text: 'Git 小技巧：`git stash -u` 可以暫存包含未追蹤檔案的修改，之後用 `git stash pop` 恢復。' },
    { category: '提示', emoji: '💡', text: 'TypeScript 技巧：用 `satisfies` 關鍵字可以在不改變型別推斷的情況下檢查型別。' },
    { category: '提示', emoji: '💡', text: 'VS Code 快捷鍵：`Ctrl+Shift+P` 開啟命令面板，幾乎所有功能都能在這裡找到。' },
    { category: '提示', emoji: '💡', text: 'Node.js 效能：`console.log` 是同步的，大量輸出會阻塞事件循環。用 `process.stdout.write` 更好。' },
    { category: '提示', emoji: '💡', text: 'CSS 小技巧：`aspect-ratio: 16/9` 可以直接設定元素的長寬比，不需要 padding hack 了。' },
    { category: '提示', emoji: '💡', text: '除錯技巧：Chrome DevTools 的 `$$()` 相當於 `document.querySelectorAll()`，在 Console 裡超方便。' },
    { category: '提示', emoji: '💡', text: 'Git 救命：`git reflog` 可以找回幾乎所有「消失」的 commit，包括 reset --hard 之後的。' },
    { category: '提示', emoji: '💡', text: 'npm 技巧：`npx npkill` 可以掃描並刪除不需要的 node_modules，釋放大量磁碟空間。' },

    // 趣味程式
    { category: '趣味', emoji: '🎮', text: 'JavaScript 的 typeof null === "object" 是一個 1995 年至今未修復的 bug，因為修它會破壞太多網站。' },
    { category: '趣味', emoji: '🎮', text: '第一個 bug（蟲子）是 1947 年在 Harvard Mark II 電腦裡找到的一隻飛蛾。' },
    { category: '趣味', emoji: '🎮', text: 'Linux 的吉祥物企鵝 Tux 的名字來自 Torvalds\'s UniX。' },
    { category: '趣味', emoji: '🎮', text: 'Python 的名字不是來自蟒蛇，而是來自英國喜劇團體 Monty Python。' },
    { category: '趣味', emoji: '🎮', text: '在 Git 中，branch 名稱 "master" 正在被 "main" 取代，但 Git 本身仍然預設用 "master"。' },
    { category: '趣味', emoji: '🎮', text: 'Google 的第一個儲存空間是用樂高積木做的硬碟架。' },
  ]
}

export async function getRandomTidbit(): Promise<TidbitResult> {
  const roll = Math.random()

  // 15% chance: ReelScript audio clip
  if (roll < 0.15) {
    const audio = await fetchReelScriptAudio()
    if (audio) return audio
  }

  // 15% chance: ReelScript text snippet
  if (roll < 0.3) {
    const snippet = await fetchReelScriptSnippet()
    if (snippet) {
      return { type: 'text', content: `${snippet.emoji} *${snippet.category}*\n${snippet.text}` }
    }
  }

  // Fallback: regular tidbits
  if (pool.length === 0) {
    pool = loadTidbits()
    usedIndices = new Set()
  }

  // Reset if all used
  if (usedIndices.size >= pool.length) {
    usedIndices = new Set()
  }

  let idx: number
  do {
    idx = Math.floor(Math.random() * pool.length)
  } while (usedIndices.has(idx))

  usedIndices.add(idx)
  const item = pool[idx]
  return { type: 'text', content: `${item.emoji} *${item.category}*\n${item.text}` }
}
