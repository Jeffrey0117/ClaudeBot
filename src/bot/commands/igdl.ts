import type { BotContext } from '../../types/context.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'
import { callAgentTool } from '../../remote/relay-server.js'
import { getScript, addScript } from '../vision/userscript-store.js'
import { parseUserscriptMeta } from '../vision/userscript-meta.js'
import { runUserscript, type RunResult, type RunDest } from '../vision/userscript-runner.js'

/** Parse an optional destination suffix: 'tg' | 'b' | 'b:<path>' | 'local'. */
export function parseDest(token: string | undefined): RunDest {
  const t = (token ?? '').trim()
  if (!t || t.toLowerCase() === 'tg') return { kind: 'tg' }
  if (t.toLowerCase() === 'b' || t.toLowerCase() === 'local') return { kind: 'local' }
  if (/^b:/i.test(t)) return { kind: 'local', dir: t.slice(2).trim() }
  return { kind: 'tg' }
}

interface IgScriptCfg {
  readonly name: string
  readonly url: string
  readonly trigger: string
}

// Smart routing: posts use the simple one-click script (406535); reels use the
// heavier IG Helper (404535) which fetches the video via IG's API. Triggers are
// baked in (the right download button per type).
const IG_SCRIPTS: Record<'post' | 'reel', IgScriptCfg> = {
  post: {
    name: '__igpost',
    url: 'https://update.greasyfork.org/scripts/406535/Instagram%20Download%20Button.user.js',
    trigger: "setTimeout(function(){document.querySelectorAll('a.download-btn').forEach(function(b){b.click()})},3000)",
  },
  reel: {
    name: '__igreel',
    url: 'https://update.greasyfork.org/scripts/404535/IG%20Helper.user.js',
    trigger: "setTimeout(function(){var b=document.querySelector('.IG_REELS');if(b)b.click()},6000)",
  },
}

/** Find an instagram.com /p/ or /reel/ URL in arbitrary text → clean url + kind. */
export function detectIgUrl(text: string): { url: string; kind: 'post' | 'reel' } | null {
  const m = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels)\/[\w-]+\/?[^\s]*/i)
  if (!m) return null
  return { url: m[0], kind: /reel/i.test(m[1]) ? 'reel' : 'post' }
}

interface PreparedScript {
  readonly code: string
  readonly trigger: string
  readonly requires?: readonly string[]
  readonly resources?: ReadonlyArray<{ name: string; url: string }>
}

/** Fetch + cache the routed script under a reserved name on first use. */
async function ensureIgScript(kind: 'post' | 'reel'): Promise<PreparedScript> {
  const cfg = IG_SCRIPTS[kind]
  let s = getScript(cfg.name)
  if (!s) {
    const res = await fetch(cfg.url)
    if (!res.ok) throw new Error(`抓腳本失敗 HTTP ${res.status}`)
    const code = await res.text()
    const meta = parseUserscriptMeta(code)
    addScript({
      name: cfg.name,
      code,
      match: [...meta.match],
      grants: [...meta.grants],
      requires: [...meta.requires],
      resources: [...meta.resources],
      trigger: cfg.trigger,
      addedAt: Date.now(),
    })
    s = getScript(cfg.name)
  }
  if (!s) throw new Error('腳本快取失敗')
  return { code: s.code, trigger: cfg.trigger, requires: s.requires, resources: s.resources }
}

/** Download an IG post/reel; deliver to the chosen destination (TG / local). */
export async function downloadIg(ctx: BotContext, rawUrl: string, dest: RunDest = { kind: 'tg' }): Promise<void> {
  const det = detectIgUrl(rawUrl)
  if (!det) {
    await ctx.reply('只支援 IG 貼文(/p/)或 reel(/reel/)連結。')
    return
  }
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message?.message_thread_id

  const destLabel = dest.kind === 'local' ? `（存${dest.dir ? ' ' + dest.dir : '本機'}）` : ''
  await ctx.reply(`📥 下載 IG ${det.kind === 'reel' ? 'Reel' : '貼文'} ${destLabel}…`)
  try {
    const prep = await ensureIgScript(det.kind)
    const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
    let result: RunResult
    if (pairing?.connected) {
      const out = await callAgentTool(
        pairing.code,
        'remote_userscript_run',
        { code: prep.code, url: det.url, trigger: prep.trigger, seconds: 25, requires: prep.requires, resources: prep.resources, dest },
        60_000,
      )
      try {
        result = JSON.parse(out) as RunResult
      } catch {
        await ctx.reply(`❌ 遠端回應異常：${/unknown tool/i.test(out) ? '遠端 agent 是舊版,需更新' : out.slice(0, 200)}`)
        return
      }
    } else {
      result = await runUserscript(prep.code, { url: det.url, trigger: prep.trigger, seconds: 25, requires: prep.requires, resources: prep.resources, dest })
    }

    if (result.files.length === 0) {
      await ctx.reply(`沒抓到檔。\n${result.logs.slice(-6).join('\n').slice(0, 800)}`)
      return
    }
    const saved = result.files.filter((f) => f.savedPath)
    if (saved.length > 0) {
      const where = pairing?.connected ? 'B' : '本機'
      await ctx.reply(`📁 已存到${where}（${saved.length} 個）:\n${saved.map((f) => f.savedPath).join('\n')}`)
      return
    }
    for (const f of result.files) {
      if (f.base64) await ctx.replyWithDocument({ source: Buffer.from(f.base64, 'base64'), filename: f.name })
    }
  } catch (e) {
    await ctx.reply(`❌ 下載失敗: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function igdlCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '')
    .replace(/^\/igdl(@\S+)?\s*/i, '').trim()
  if (!text) {
    await ctx.reply('用法: /igdl <IG 連結> [去處]\n去處: 預設傳 TG｜b 存 B 本機｜b:<資料夾> 指定路徑\n(或直接把 IG 連結丟給我就會自動傳 TG)')
    return
  }
  const url = text.split(/\s+/)[0]
  const destToken = text.slice(text.indexOf(url) + url.length).trim()
  await downloadIg(ctx, url, parseDest(destToken))
}
