import type { BotContext } from '../../types/context.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'
import { callAgentTool } from '../../remote/relay-server.js'
import { validateUrl } from '../../utils/validate-url.js'
import { addScript, getScript, listScripts, removeScript } from '../vision/userscript-store.js'
import { parseUserscriptMeta } from '../vision/userscript-meta.js'
import { runUserscript, type RunResult } from '../vision/userscript-runner.js'

const SHIMMED_GRANTS = [
  'GM_download', 'GM_xmlhttpRequest', 'GM_addStyle',
  'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
  'GM_setClipboard', 'GM_openInTab', 'GM_registerMenuCommand',
  'GM_unregisterMenuCommand', 'GM_info',
]

async function fetchCode(urlOrCode: string): Promise<string> {
  if (/==UserScript==/.test(urlOrCode)) return urlOrCode
  if (/^https?:\/\//i.test(urlOrCode)) {
    validateUrl(urlOrCode)
    const res = await fetch(urlOrCode)
    if (!res.ok) throw new Error(`抓腳本失敗 HTTP ${res.status}`)
    return await res.text()
  }
  return urlOrCode
}

export async function usCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message?.message_thread_id
  const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '')
    .replace(/^\/us(@\S+)?\s*/i, '').trim()
  const parts = raw.split(/\s+/)
  const sub = parts[0]
  const rest = parts.slice(1)

  if (sub === 'list') {
    const items = listScripts()
    await ctx.reply(
      items.length
        ? items.map((s) => `• ${s.name} — ${s.match.join(', ') || '(no @match)'}`).join('\n')
        : '還沒有腳本。用 /us add <name> <url|貼程式碼>',
    )
    return
  }

  if (sub === 'rm') {
    await ctx.reply(
      removeScript(rest[0] ?? '')
        ? `🗑️ 已刪 ${rest[0]}`
        : `找不到 ${rest[0]}`,
    )
    return
  }

  if (sub === 'add') {
    const name = rest[0]
    const src = name ? raw.slice(raw.indexOf(name) + name.length).trim() : ''
    if (!name || !src) {
      await ctx.reply('用法: /us add <name> <url 或直接貼整段腳本>')
      return
    }
    try {
      const code = await fetchCode(src)
      const meta = parseUserscriptMeta(code)
      addScript({ name, code, match: [...meta.match], grants: [...meta.grants], requires: [...meta.requires], resources: [...meta.resources], addedAt: Date.now() })
      const unguarded = meta.grants.filter((g) => !SHIMMED_GRANTS.includes(g))
      // No parse_mode: @match patterns contain '*' / '_' which break Markdown.
      await ctx.reply(
        `✅ 已存 ${name}\n@match: ${meta.match.join(', ') || '(無)'}\n@grant: ${meta.grants.join(', ') || '(無)'}` +
        (unguarded.length ? `\n⚠️ 沒墊到的 GM 函式(可能跑不動): ${unguarded.join(', ')}` : ''),
      )
    } catch (e) {
      await ctx.reply(`❌ add 失敗: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }

  if (sub === 'run') {
    const name = rest[0]
    const url = rest[1]
    const trigger = rest.slice(2).join(' ') || undefined
    const script = name ? getScript(name) : undefined
    if (!script || !url || !/^https?:\/\//i.test(url)) {
      await ctx.reply('用法: /us run <name> <url> [觸發JS]\n例: /us run igdl https://www.instagram.com/p/xxx/')
      return
    }
    try {
      validateUrl(url)
    } catch {
      await ctx.reply('❌ 不允許內部/私有網址')
      return
    }
    await ctx.reply(`▶️ 跑 ${name} 於 ${url} …`)
    try {
      const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
      let result: RunResult
      if (pairing?.connected) {
        const rawOut = await callAgentTool(
          pairing.code,
          'remote_userscript_run',
          { code: script.code, url, trigger: trigger ?? script.trigger, seconds: 25, requires: script.requires, resources: script.resources },
          60_000,
        )
        try {
          result = JSON.parse(rawOut) as RunResult
        } catch {
          await ctx.reply(
            `❌ 遠端回應異常：${
              /unknown tool/i.test(rawOut)
                ? '遠端 agent 是舊版（沒有 userscript 工具），需更新'
                : rawOut.slice(0, 300)
            }`,
          )
          return
        }
      } else {
        result = await runUserscript(script.code, { url, trigger: trigger ?? script.trigger, seconds: 25, requires: script.requires, resources: script.resources })
      }
      for (const f of result.files) {
        if (f.base64) await ctx.replyWithDocument({ source: Buffer.from(f.base64, 'base64'), filename: f.name })
      }
      const tail = result.logs.slice(-8).join('\n').slice(0, 1500)
      await ctx.reply(`✅ ${name} 跑完，${result.files.length} 個檔。\n${tail}`)
    } catch (e) {
      await ctx.reply(`❌ run 失敗: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }

  await ctx.reply('用法:\n/us add <name> <url|貼腳本>\n/us list\n/us rm <name>\n/us run <name> <url> [觸發JS]')
}
